// The engine's HTTP API. `npm run serve` (bin.ts) runs it for the Mac app: random port + token.
// Run directly (`npm run dashboard`) it is the dev dashboard: http://localhost:4000, no token.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { config } from "../config.ts";
import { makeDispatcher } from "./http.ts";
import { defaultTasks, JobRunner, type TaskTable } from "./jobs.ts";
import { buildRoutes } from "./routes.ts";

export type ServerOptions = {
  port?: number; // 0 = pick a free one
  token?: string; // when set, every API request needs `Authorization: Bearer <token>`
  tasks?: TaskTable; // tests inject fake tasks
};

export const startServer = async ({ port = 0, token, tasks = defaultTasks() }: ServerOptions = {}) => {
  const runner = new JobRunner(tasks);
  const server = createServer(makeDispatcher(buildRoutes(runner, { devPage: !token }), token));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve); // loopback only
  });
  const address = server.address();
  return {
    port: typeof address === "object" && address ? address.port : port,
    runner,
    close: () => {
      runner.shutdown();
      server.closeAllConnections(); // ends SSE streams
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { port } = await startServer({ port: config.port });
  console.log(`Dashboard → http://localhost:${port}`);
}
