import type { Workflow, WorkflowStep, StepExecution } from '~/types'
import {
  buildGraph,
  initRunState,
  readyNodes,
  markRunning,
  markCompleted,
  markFailed,
  skipPending,
  isFinished,
  armNode,
  canRevisit,
  joinInputs,
  parseVerdict,
  monitorPrompt,
  MAX_CONCURRENCY,
  type WorkflowGraph,
  type RunState,
} from '~/utils/workflowGraph'

/**
 * Runs a workflow as a graph rather than a list: several nodes can run in one wave,
 * back edges can send it round again, and a per-node monitor agent can veto an output.
 * The run pauses between waves for review, exactly as the linear version did.
 */
export function useWorkflowExecution() {
  const steps = ref<StepExecution[]>([])
  const isRunning = ref(false)
  const isPaused = ref(false)
  const isComplete = ref(false)
  /** Nodes in the wave that just ran. Replaces the old single currentStepIndex. */
  const currentStepIds = ref<string[]>([])
  /** Nodes queued for the next wave - what the pause bar offers to continue to. */
  const nextStepIds = ref<string[]>([])

  let abortController: AbortController | null = null
  let _workflow: Workflow | null = null
  let _projectDir: string | undefined
  let _initialPrompt = ''
  let _graph: WorkflowGraph | null = null
  let _state: RunState | null = null
  /** When true, each finished wave rolls straight into the next instead of pausing. */
  let _autoRun = false

  const outputs: Record<string, string> = {}
  const lastInputs: Record<string, string> = {}
  /** Monitor review staged by runMonitor, promoted to retryFeedback only if the retry runs. */
  const pendingReview: Record<string, string> = {}
  const retryFeedback: Record<string, string> = {}

  const stepById = (id: string): WorkflowStep | undefined => _workflow?.steps.find(s => s.id === id)
  const labelOf = (id: string): string => stepById(id)?.label || 'Step'
  const indexOf = (id: string): number => steps.value.findIndex(s => s.stepId === id)

  function patch(id: string, changes: Partial<StepExecution>) {
    const i = indexOf(id)
    if (i === -1) return
    steps.value[i] = { ...steps.value[i]!, ...changes } as StepExecution
  }

  /** One agent call over the SSE endpoint. onDelta streams partial text for live output. */
  async function streamAgent(agentSlug: string, input: string, onDelta?: (text: string) => void): Promise<string> {
    const response = await $fetch<ReadableStream>('/api/chat', {
      method: 'POST',
      body: {
        messages: [{ role: 'user', content: input }],
        agentSlug,
        ...(_projectDir ? { projectDir: _projectDir } : {}),
      },
      signal: abortController?.signal,
      responseType: 'stream',
    })

    const reader = (response as unknown as ReadableStream).getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let resultText = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        try {
          const data = JSON.parse(line.slice(6))
          if (data.type === 'text_delta') {
            resultText += data.text
            onDelta?.(resultText)
          } else if (data.type === 'result') {
            resultText = data.text
            onDelta?.(resultText)
          } else if (data.type === 'error') {
            throw new Error(data.message)
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue
          throw e
        }
      }
    }

    return resultText
  }

  /**
   * What this node receives: the run prompt for an entry node, the monitor's feedback on a
   * retry, the triggering node's output when a back edge brought us here, otherwise every
   * forward predecessor's output joined together.
   */
  function computeInput(id: string): string {
    const feedback = retryFeedback[id]
    if (feedback) {
      delete retryFeedback[id]
      return [
        lastInputs[id] ?? _initialPrompt,
        '---',
        'Your previous attempt:',
        outputs[id] ?? '',
        '---',
        'Reviewer feedback:',
        feedback,
        'Revise your work and produce a corrected result.',
      ].join('\n\n')
    }

    const trigger = _state?.triggeredBy[id]
    if (trigger) return outputs[trigger] ?? ''

    const preds = _graph?.forwardPreds[id] ?? []
    if (!preds.length) return _initialPrompt
    return joinInputs(preds.map(p => ({ label: labelOf(p), text: outputs[p] ?? '' })))
  }

  async function runMonitor(step: WorkflowStep, input: string, output: string) {
    if (!step.monitorSlug) return 'CONTINUE' as const
    try {
      const review = await streamAgent(
        step.monitorSlug,
        monitorPrompt({ label: step.label, agentSlug: step.agentSlug, input, output }),
      )
      const verdict = parseVerdict(review)
      patch(step.id, { monitorVerdict: verdict, monitorNote: review })
      // Only stage the feedback once we know the retry can actually happen - see executeNode.
      if (verdict === 'RETRY') pendingReview[step.id] = review
      return verdict
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') throw err
      // A broken monitor must not take the workflow down with it.
      patch(step.id, {
        monitorVerdict: 'CONTINUE',
        monitorNote: `Monitor failed: ${err instanceof Error ? err.message : 'unknown error'}`,
      })
      return 'CONTINUE' as const
    }
  }

  /** Returns false if the run should stop - a failure, or an ABORT verdict. */
  async function executeNode(id: string, inputOverride?: string): Promise<boolean> {
    const step = stepById(id)
    if (!step || !_graph || !_state) return false

    const input = inputOverride ?? computeInput(id)
    lastInputs[id] = input
    markRunning(_state, id)
    patch(id, {
      status: 'running',
      input,
      output: '',
      error: undefined,
      completedAt: undefined,
      monitorVerdict: undefined,
      monitorNote: undefined,
      startedAt: Date.now(),
      visits: _state.visits[id],
    })

    try {
      const output = await streamAgent(step.agentSlug, input, text => patch(id, { output: text }))
      outputs[id] = output
      patch(id, { status: 'completed', output, completedAt: Date.now() })

      if (step.monitorSlug) {
        const verdict = await runMonitor(step, input, output)
        if (verdict === 'ABORT') {
          markFailed(_state, id)
          patch(id, { status: 'failed', error: 'Monitor aborted the workflow' })
          return false
        }
        if (verdict === 'RETRY' && canRevisit(_graph, _state, id)) {
          // Hold the successors back - this output is not good enough to pass on yet.
          retryFeedback[id] = pendingReview[id] ?? ''
          delete pendingReview[id]
          _state.status[id] = 'completed'
          armNode(_state, id)
          return true
        }
        // Out of visits (or nothing to redo): drop the review so a later loop round
        // cannot pick up stale feedback, and let the output through as it stands.
        delete pendingReview[id]
      }

      markCompleted(_graph, _state, id)
      return true
    } catch (err: unknown) {
      const cancelled = err instanceof Error && err.name === 'AbortError'
      markFailed(_state, id)
      patch(id, {
        status: 'failed',
        error: cancelled ? 'Cancelled' : err instanceof Error ? err.message : 'Unknown error',
        completedAt: Date.now(),
      })
      return false
    }
  }

  function finish() {
    isRunning.value = false
    isPaused.value = false
    isComplete.value = true
    nextStepIds.value = []
  }

  /** Run every ready node, up to the concurrency cap, then pause for review. */
  async function runWave() {
    if (!_graph || !_state || isRunning.value) return

    const wave = readyNodes(_graph, _state).slice(0, MAX_CONCURRENCY)
    if (!wave.length) {
      finish()
      return
    }

    currentStepIds.value = wave
    nextStepIds.value = []
    isRunning.value = true
    isPaused.value = false

    const results = await Promise.all(wave.map(id => executeNode(id)))

    isRunning.value = false

    if (results.some(ok => !ok)) {
      skipPending(_state)
      for (const exec of steps.value) {
        if (exec.status === 'pending') patch(exec.stepId, { status: 'skipped' })
      }
      isPaused.value = false
      isComplete.value = true
      nextStepIds.value = []
      return
    }

    if (isFinished(_graph, _state)) {
      finish()
      return
    }

    nextStepIds.value = readyNodes(_graph, _state).slice(0, MAX_CONCURRENCY)

    // Failures and ABORT verdicts have already returned above, so reaching here means
    // the run is healthy and a human gate is the only thing that would stop it.
    if (_autoRun) {
      await runWave()
      return
    }

    isPaused.value = true
  }

  async function run(workflow: Workflow, initialPrompt: string, projectDir?: string, autoRun = false) {
    if (isRunning.value || !workflow.steps.length) return

    const { workingDir } = useWorkingDir()
    _workflow = workflow
    _projectDir = projectDir || workingDir.value || undefined
    _initialPrompt = initialPrompt
    _autoRun = autoRun
    _graph = buildGraph(workflow.steps)
    _state = initRunState(_graph)
    abortController = new AbortController()

    for (const key of Object.keys(outputs)) delete outputs[key]
    for (const key of Object.keys(lastInputs)) delete lastInputs[key]
    for (const key of Object.keys(retryFeedback)) delete retryFeedback[key]
    for (const key of Object.keys(pendingReview)) delete pendingReview[key]

    isComplete.value = false
    currentStepIds.value = []
    nextStepIds.value = []
    steps.value = workflow.steps.map(s => ({
      stepId: s.id,
      status: 'pending' as const,
      input: '',
      output: '',
      visits: 0,
    }))

    await runWave()
  }

  /** Continue to the next wave with the outputs as they stand. */
  async function continueWorkflow() {
    if (!isPaused.value) return
    await runWave()
  }

  /**
   * Continue after editing the output. Only offered when the wave produced a single node,
   * so there is no ambiguity about which output is being replaced.
   */
  async function continueWith(text: string) {
    if (!isPaused.value) return
    const id = currentStepIds.value[0]
    if (currentStepIds.value.length === 1 && id) {
      outputs[id] = text
      patch(id, { output: text })
    }
    await runWave()
  }

  /** Re-run the node that just ran, feeding it the user's reply. A human retry ignores maxVisits. */
  async function respondToStep(reply: string) {
    if (!isPaused.value || isRunning.value) return
    const id = currentStepIds.value[0]
    if (currentStepIds.value.length !== 1 || !id || !_graph || !_state) return

    const combinedInput = `Previous agent output:\n${outputs[id] ?? ''}\n\nUser response:\n${reply}`
    isRunning.value = true
    isPaused.value = false
    const ok = await executeNode(id, combinedInput)
    isRunning.value = false

    if (!ok) {
      skipPending(_state)
      isComplete.value = true
      return
    }
    if (isFinished(_graph, _state)) {
      finish()
      return
    }
    nextStepIds.value = readyNodes(_graph, _state).slice(0, MAX_CONCURRENCY)
    isPaused.value = true
  }

  function stop() {
    abortController?.abort()
    isRunning.value = false
    isPaused.value = false
    if (_state) skipPending(_state)
    for (const exec of steps.value) {
      if (exec.status === 'pending') patch(exec.stepId, { status: 'skipped' })
    }
    nextStepIds.value = []
  }

  return {
    steps: readonly(steps),
    isRunning: readonly(isRunning),
    isPaused: readonly(isPaused),
    isComplete: readonly(isComplete),
    currentStepIds: readonly(currentStepIds),
    nextStepIds: readonly(nextStepIds),
    run,
    continueWorkflow,
    continueWith,
    respondToStep,
    stop,
  }
}
