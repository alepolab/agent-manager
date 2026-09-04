Ticket DEVOPS-23 (project DEVOPS, type Bug, priority Blocker, status To Do).

Summary: PMSS solution (pms-billing, pms-ratingengine, pms-partner-management) has no host volume mounts configured for License, log, ratesheetDir, invoiceDir, invoiceTemplates, billStatementTemplates; all such data lives only in ephemeral container layers.

Detail: The PMSS solution is deployed via Docker Compose (docker-compose.pms.yml) with three core containers: pms-billing, pms-ratingengine, pms-partner-management. None has the expected host-mounted folders. docker inspect confirms: pms-billing "Mounts": [], pms-partner-management "Mounts": [], pms-ratingengine has only the named volume pms_pms-cdr-data -> /app/CDR. All three report healthy, because health checks only probe HTTP/socket endpoints and do not detect missing persistence.

Relevant env vars:
- pms-billing: INVOICE_DIRECTORY=/app/invoiceDir, LOG_FILE=/logs/billing.log, BILLING_HOME=/app, BILL_STATEMENT_PREFIX=BIL
- pms-ratingengine: RATESHEET_DIRECTORY=./ratesheetDir, LOG_FILE=./log/interconnect_logging.log, INPUT_TEMPLATE_FILE=./template/inputTemplate.txt, OUTPUT_TEMPLATE_FILE=./template/outputTemplate.txt, RATING_HOME=/app, CDR_DIRECTORY_PATH=/app/CDR
- pms-partner-management: LOG_FILE=./logs/pms.log, PMS_HOME=/app

Expected: docker-compose.pms.yml should bind-mount host directories into each container for its required directories so this data persists across container recreation and is manageable on the host.

CONTEXT AND CONSTRAINTS FOR THIS RUN — read carefully:
- The repository to change is /home/alepo/alepo-dev-team-infra, currently on branch develop. The file is docker-compose.pms.yml.
- Branch naming is enforced at push time: use fix/DEVOPS-23-<short-slug>.
- Classify this as work_type "infra" and blast_radius "deployment". The class enum has no value that fits a missing bind mount, so class is null; deployment is the correct blast radius for a defect whose failure mode is in how the system is deployed or operated rather than in code behaviour. Do not stretch "schema" to cover it.
- The oracle here does NOT need a running stack: "docker compose config" renders the merged compose file statically and deterministically. A parameterised test over the three services x their required directories, asserting a host bind mount exists for each, is the right oracle. It must FAIL before the fix.
- You CANNOT stand up the PMS stack. It runs on host 172.16.115.61, to which this session has no shell access. If the stack-provisioning step cannot proceed, say so and halt rather than pretending.
- DO NOT push any branch and DO NOT open a pull request. Commit locally only. In place of opening a PR, write the PR body you would have submitted into the run artifacts directory as pr-body.md, and record the intended PR URL as null.
