/**
 * `oasis cron ...`: manage and run scheduled jobs without opening a session.
 *
 *   oasis cron list              show jobs
 *   oasis cron tick              run the jobs that are due, then exit (for a system crontab)
 *   oasis cron daemon            keep running and tick every 30 seconds
 *   oasis cron run <id>          run one job now
 *   oasis cron pause|resume|remove <id>
 *   oasis cron runs <id>         recent results
 */
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { runNow, tick } from "./runner.ts";
import { CronStore, describeJob } from "./store.ts";

const USAGE = "usage: oasis cron list | tick | daemon | run <id> | runs <id> | pause <id> | resume <id> | remove <id>";

export async function cronCli(args: string[], log: (line: string) => void = console.log, base = getAgentDir()): Promise<number> {
	const store = new CronStore(base);
	const [verb = "list", id] = args;
	const need = () => {
		if (!id) throw new Error(USAGE);
		return id;
	};
	try {
		switch (verb) {
			case "list": {
				const jobs = store.list();
				log(jobs.length ? jobs.map(describeJob).join("\n") : "No scheduled jobs.");
				return 0;
			}
			case "tick": {
				for (const run of await tick(store)) log(`${run.jobId} ${run.status}${run.error ? ` (${run.error})` : ""}`);
				return 0;
			}
			case "daemon": {
				log(`oasis cron daemon: ${store.list().length} job(s) in ${store.dir}; ticking every 30s. Ctrl+C to stop.`);
				let stop = false;
				process.once("SIGINT", () => {
					stop = true;
				});
				process.once("SIGTERM", () => {
					stop = true;
				});
				while (!stop) {
					try {
						for (const run of await tick(store))
							log(`${new Date().toISOString()} ${run.jobId} ${run.status}${run.error ? ` (${run.error})` : ""}`);
					} catch (error) {
						log(`tick failed: ${(error as Error).message}`);
					}
					for (let i = 0; i < 30 && !stop; i++) await new Promise((r) => setTimeout(r, 1000));
				}
				return 0;
			}
			case "run": {
				const run = await runNow(store, need());
				log(`${run.status}${run.error ? ` (${run.error})` : ""}\n${run.output ?? ""}`);
				return run.status === "ok" ? 0 : 1;
			}
			case "runs": {
				const job = store.get(need());
				if (!job) throw new Error(`no job "${id}".`);
				for (const r of store.runs(job.id)) log(`${r.startedAt} ${r.status}${r.error ? ` (${r.error})` : ""}\n${r.output ?? ""}\n`);
				return 0;
			}
			case "pause":
			case "resume":
				log(describeJob(store.update(need(), { paused: verb === "pause" })));
				return 0;
			case "remove":
				log(`removed ${store.remove(need()).id}`);
				return 0;
			default:
				log(USAGE);
				return 2;
		}
	} catch (error) {
		log(`oasis cron: ${(error as Error).message}`);
		return 1;
	}
}
