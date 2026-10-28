// Where the job-search tool reads/writes its data (data/job-search/). Trailing slash: callers append file names.
import { config } from "../../config.ts";

export const OUTPUT_DIR = `${config.jobSearchDir}/`;
