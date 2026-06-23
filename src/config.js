export function readConfig(env = process.env) {
  return {
    port: Number.parseInt(env.PORT ?? "3000", 10),
    nodeEnv: env.NODE_ENV ?? "development",
  };
}
