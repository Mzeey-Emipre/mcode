function readArgument(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
}

/** Parses the renderer performance runtime. */
export function parsePerformanceRuntime(args = process.argv) {
  const value = readArgument(args, "--runtime") ?? "paired";
  if (value !== "paired" && value !== "standalone-web") {
    throw new Error("--runtime must be paired or standalone-web");
  }
  return value;
}

/** Parses the renderer performance build mode. */
export function parsePerformanceMode(args = process.argv) {
  const value = readArgument(args, "--mode") ?? "production";
  if (value !== "profiling" && value !== "production") {
    throw new Error("--mode must be profiling or production");
  }
  return value;
}

/** Parses the renderer performance sample count for one runtime. */
export function parsePerformanceSampleCount(
  runtime = parsePerformanceRuntime(),
  args = process.argv,
) {
  const value = Number(readArgument(args, "--sample-count") ?? "7");
  const minimum = runtime === "standalone-web" ? 1 : 3;
  if (!Number.isSafeInteger(value) || value < minimum || value > 20) {
    throw new Error(
      runtime === "standalone-web"
        ? "--sample-count must be an integer from 1 through 20"
        : "--sample-count must be an integer from 3 through 20",
    );
  }
  return value;
}

/** Parses and validates the renderer performance command options. */
export function parsePerformanceOptions(args = process.argv) {
  const runtime = parsePerformanceRuntime(args);
  const mode = parsePerformanceMode(args);
  const sampleCount = parsePerformanceSampleCount(runtime, args);
  return { runtime, mode, sampleCount };
}
