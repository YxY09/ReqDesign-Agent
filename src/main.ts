#!/usr/bin/env node

import { Command } from "commander";
import { existsSync } from "node:fs";
import { AgentConfig, VALID_PROVIDERS } from "./config.js";
import { setConsoleLoggingEnabled, setupLogger, closeSharedLog, writeToSharedLog } from "./logger.js";
import { MultiAgentRuntime } from "./runtime.js";
import { BenchmarkRunner } from "./benchmark/runBenchmark.js";
import { TerminalChatApp } from "./tui/chatApp.js";
import { ConsoleWorkflowStreamer } from "./workflowEvents.js";

interface CommonCliArgs {
  config: string;
  model?: string;
  provider?: string;
  maxRetry?: string;
  logLevel: string;
}

function loadConfig(args: CommonCliArgs): { config: AgentConfig; logger: ReturnType<typeof setupLogger> } {
  const logger = setupLogger("reqdesign", args.logLevel);
  const configPath = args.config && args.config !== "undefined" ? args.config : "config.yaml";
  const config = existsSync(configPath)
    ? AgentConfig.loadFromYaml(configPath)
    : new AgentConfig();

  if (args.model) config.llm.model = args.model;
  if (args.provider) {
    if (!(VALID_PROVIDERS as readonly string[]).includes(args.provider)) {
      throw new Error(`unsupported provider: ${args.provider}`);
    }
    config.llm.provider = args.provider as (typeof VALID_PROVIDERS)[number];
  }
  if (args.maxRetry) config.retry.maxRetries = Number(args.maxRetry);

  const errors = config.validate();
  if (errors.length > 0) {
    for (const error of errors) {
      logger.error(error);
    }
    throw new Error("config validation failed");
  }
  if (!config.getApiKey()) {
    logger.error(`API key is missing. provider=${config.llm.provider}, model=${config.llm.model}, baseUrl=${config.getBaseUrl()}`);
    throw new Error("API key is missing");
  }
  return { config, logger };
}

async function runChat(argv: string[]): Promise<void> {
  const program = new Command();
  program
    .name("reqdesign chat")
    .description("Full-screen terminal chat UI")
    .option("-c, --config <path>", "Config file path", "config.yaml")
    .option("-m, --model <model>", "Override model from config")
    .option("-p, --provider <provider>", "Override LLM provider from config")
    .option("--max-retry <count>", "Override max retry count from config")
    .option("--log-level <level>", "Log level", "INFO")
    .option("--execution-backend <backend>", "Execution backend: thread", "thread");
  program.parse(["node", "reqdesign-chat", ...argv]);
  const args = program.opts<CommonCliArgs & { executionBackend: string }>();
  const { config } = loadConfig(args);
  setConsoleLoggingEnabled(false);
  const app = new TerminalChatApp({
    config,
    executionBackend: args.executionBackend,
  });
  await app.start();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "chat") {
    await runChat(argv.slice(1));
    return;
  }

  const program = new Command();
  program
    .name("reqdesign")
    .description("ReqDesign-Agent: an LLM-based requirements analysis and system design assistant")
    .option("--goal <goal>", "Task goal: design (analyze is internal only)", "design")
    .requiredOption("-i, --input <path>", "Input requirement document path")
    .option("-o, --output <path>", "Output directory")
    .option("-c, --config <path>", "Config file path", "config.yaml")
    .option("-m, --model <model>", "Override model from config")
    .option("-p, --provider <provider>", "Override LLM provider from config")
    .option("--max-retry <count>", "Override max retry count from config")
    .option("--log-level <level>", "Log level", "INFO")
    .option("--benchmark", "Run benchmark evaluation", false)
    .option("--execution-backend <backend>", "Execution backend: thread", "thread");

  program.parse(process.argv);
  const args = program.opts<{
    goal: string;
    input: string;
    output?: string;
    config: string;
    model?: string;
    provider?: string;
    maxRetry?: string;
    logLevel: string;
    benchmark: boolean;
    executionBackend: string;
  } & CommonCliArgs>();

  if (args.goal !== "design") {
    throw new Error(`unsupported goal: ${args.goal}. Public CLI runs only design; analyze is an internal workflow stage.`);
  }

  const { config } = loadConfig(args);
  const output = args.output ?? config.output.defaultDir;

  if (args.benchmark) {
    const streamer = new ConsoleWorkflowStreamer();
    const runner = new BenchmarkRunner(
      config,
      args.input,
      "benchmark/gold_labels",
      output,
    );
    const report = await runner.runAll({
      onEvent: (event) => streamer.push(event),
    });
    streamer.close();
    const summary = (report.summary as Record<string, unknown> | undefined) ?? {};
    const benchLines = [
      `Benchmark complete. Output directory: ${output}`,
      `Passed: ${String(summary.passed ?? 0)} / ${String(report.total_cases ?? 0)}`,
      `Average overall: ${String((summary.avg_scores as Record<string, unknown> | undefined)?.overall ?? 0)}`,
    ];
    for (const line of benchLines) {
      process.stdout.write(line + "\n");
      writeToSharedLog(line);
    }
    return;
  }

  const streamer = new ConsoleWorkflowStreamer();
  const runtime = new MultiAgentRuntime(config, args.executionBackend);
  const state = await runtime.run(args.goal, args.input, output, {
    onEvent: (event) => streamer.push(event),
  });
  streamer.close();

  const summaryLines = [
    `Run ended. Output directory: ${output}`,
    `  backend: ${runtime.executionBackendName}`,
    `  artifacts: ${String(state.totalArtifacts)}`,
    `  finished: ${state.finished ? "yes" : "no"}`,
    `  run status: ${state.runStatus}`,
    `  quality status: ${state.qualityStatus}`,
    `  persist status: ${state.persistStatus}`,
  ];
  if (state.latestVerdict) {
    const verdictStatus = state.finalReviewDone
      ? state.finalReviewPassed
        ? "passed"
        : state.latestVerdict.passed
          ? "accepted_with_major_issues"
          : "rejected"
      : state.latestVerdict.passed
        ? "accepted_no_blockers"
        : "rejected";
    summaryLines.push(`  verdict: ${verdictStatus}`);
    summaryLines.push(`  review rounds: ${String(state.verdicts.length)}`);
  }
  if (state.plan) {
    summaryLines.push(`  planned tasks: ${String(state.plan.tasks.length)}`);
  }
  if (state.errors.length > 0) {
    summaryLines.push(`  errors: ${String(state.errors.length)}`);
  }
  for (const line of summaryLines) {
    process.stdout.write(line + "\n");
    writeToSharedLog(line);
  }

  if (!state.persisted) {
    process.exitCode = 1;
  }
  closeSharedLog();
}

main().catch((error: unknown) => {
  const msg = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(msg + "\n");
  writeToSharedLog(msg);
  process.exitCode = 1;
}).finally(() => closeSharedLog());
