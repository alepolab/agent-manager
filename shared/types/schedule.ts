/**
 * A schedule: one workflow, one cron expression, one set of stated inputs.
 *
 * Deliberately NOT a mode on Watch. A watch is ticket-shaped end to end - it
 * polls a query, dedupes by ticket key, tracks a per-ticket disposition and
 * escalates after three attempts - and none of that means anything for "run
 * the security scan at 2am". Sharing the type would have forced a synthetic
 * unique ticket key per fire, which grows watch-state/<id>.json forever and
 * points the escalation logic at nonsense.
 */
export interface Schedule {
  id: string
  name: string
  workflowSlug: string
  /**
   * A 5- or 6-field cron expression, parsed by croner. Validated when it is
   * saved, never at fire time: a schedule that cannot be parsed must be
   * refused while a person is looking at it, not silently dead at 2am.
   */
  cron: string
  /** IANA zone (e.g. 'Asia/Kolkata'). Absent means the server's local time. */
  timezone?: string
  /**
   * Where its runs work. Absent means the directory derived from its id - see
   * scheduleWorkspace - which nothing else touches but which starts empty.
   *
   * Stating one is how a schedule scans a REAL repository. Without it a scan
   * workflow pointed at a checkout by hand would, on a schedule, work in an
   * empty derived directory and find nothing to scan, which is the whole
   * reason declared inputs exist.
   *
   * The cost is accepted, and the run lock is what makes it safe to accept: a
   * fire landing while anything else is working there degrades to `skipped`
   * carrying the other run's id, which is a visible, attributable outcome
   * rather than two runs editing one checkout. Canonicalised on save
   * (canonicalProjectDir), because that lock compares directory strings.
   */
  projectDir?: string
  /**
   * New schedules start disabled and enabling is a second, deliberate save -
   * the same invariant watchConfig.ts enforces, for the same reason: a
   * schedule saved with a mistyped expression must not fire before the person
   * who typed it has looked at what it will do.
   */
  enabled: boolean
  initialPrompt: string
  /**
   * Values for the workflow's declared parameters, resolved against those
   * declarations at fire time.
   *
   * A `projectDir` key is never stored here: the field above is the one place
   * a directory is stated, so there is one answer rather than two that can
   * disagree. At fire time the EFFECTIVE directory - stated, else derived - is
   * substituted for it (see scheduleProjectDir). Substituted rather than
   * dropped so a workflow that declares `projectDir` as required is still
   * schedulable, and so what the agents are told matches where they work.
   */
  parameters?: Record<string, string>
  autoRun: boolean
  /** Owner. Runs fire under this identity, exactly as a watch's runs do. */
  createdBy?: string
}

/**
 * What happened on the last fire. Kept in its own file, never on the Schedule
 * itself: schedules.json is read-modify-write with no lock (see
 * server/utils/teamSync.ts), so a per-fire write into it would race the API's.
 *
 * `skipped` is not a failure. A schedule whose own previous run is still going
 * waits for its next fire rather than queueing behind itself, because a
 * nightly scan that starts at 10am is worse than one that does not start.
 */
export interface ScheduleState {
  lastFiredAt?: number
  lastRunId?: string
  /**
   * `queued` is not `started`. A fire whose concurrency group was full
   * produced a real run with a real id — `lastRunId` names it — but that run
   * is waiting for a slot, and a Schedules page reporting "started at 2am"
   * for it would be describing work that had not begun.
   */
  lastOutcome?: 'started' | 'queued' | 'skipped' | 'error'
  /** The reason, when it was skipped or failed. Absent on a clean start. */
  lastDetail?: string
}

/** No catch-up: a fire missed while the server was down does not replay. */
export const SCHEDULES_FILE_NAME = 'schedules.json'
export const SCHEDULE_STATE_DIR_NAME = 'schedule-state'
