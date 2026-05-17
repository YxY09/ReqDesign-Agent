#!/usr/bin/env node

import { Command } from "commander";
import { existsSync } from "node:fs";
import { AgentConfig } from "./config.js";
import { setConsoleLoggingEnabled, setupLogger } from "./logger.js";
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
  if (args.provider) config.llm.provider = args.provider;
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
    .option("--goal <goal>", "Task goal: analyze or design", "design")
    .requiredOption("-i, --input <path>", "Input requirement document path")
    .option("-o, --output <path>", "Output directory", "outputs/")
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
    output: string;
    config: string;
    model?: string;
    provider?: string;
    maxRetry?: string;
    logLevel: string;
    benchmark: boolean;
    executionBackend: string;
  } & CommonCliArgs>();

  const { config } = loadConfig(args);

  if (args.benchmark) {
    const streamer = new ConsoleWorkflowStreamer();
    const runner = new BenchmarkRunner(
      config,
      args.input,
      "benchmark/gold_labels",
      args.output,
    );
    const report = await runner.runAll({
      onEvent: (event) => streamer.push(event),
    });
    streamer.close();
    const summary = (report.summary as Record<string, unknown> | undefined) ?? {};
    process.stdout.write(`\nBenchmark complete. Output directory: ${args.output}\n`);
    process.stdout.write(`Passed: ${String(summary.passed ?? 0)} / ${String(report.total_cases ?? 0)}\n`);
    process.stdout.write(`Average overall: ${String((summary.avg_scores as Record<string, unknown> | undefined)?.overall ?? 0)}\n`);
    return;
  }

  const streamer = new ConsoleWorkflowStreamer();
  const runtime = new MultiAgentRuntime(config, args.executionBackend);
  const state = await runtime.run(args.goal, args.input, args.output, {
    onEvent: (event) => streamer.push(event),
  });
  streamer.close();

  process.stdout.write(`\nTask finished. Output directory: ${args.output}\n`);
  process.stdout.write(`  backend: ${runtime.executionBackendName}\n`);
  process.stdout.write(`  artifacts: ${String(state.totalArtifacts)}\n`);
  process.stdout.write(`  finished: ${state.finished ? "yes" : "no"}\n`);
  if (state.latestVerdict) {
    process.stdout.write(`  verdict: ${state.latestVerdict.passed ? "passed" : "rejected"}\n`);
    process.stdout.write(`  review rounds: ${String(state.verdicts.length)}\n`);
  }
  if (state.plan) {
    process.stdout.write(`  planned tasks: ${String(state.plan.tasks.length)}\n`);
  }
  if (state.errors.length > 0) {
    process.stdout.write(`  errors: ${String(state.errors.length)}\n`);
  }

  if (!state.persisted && state.runStatus === "failed") {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
