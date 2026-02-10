import test from "ava";
import {
	BENCHMARK_PRESETS,
	type BenchmarkPreset,
	type PresetConfig,
} from "../types/index.js";

test("BENCHMARK_PRESETS contains all expected presets", (t) => {
	const expectedPresets: BenchmarkPreset[] = ["low", "medium", "high", "ultra"];

	for (const presetName of expectedPresets) {
		t.truthy(
			BENCHMARK_PRESETS[presetName],
			`Preset '${presetName}' should exist`,
		);
	}

	t.is(Object.keys(BENCHMARK_PRESETS).length, 4);
});

test("Low preset has correct configuration", (t) => {
	const preset: PresetConfig = BENCHMARK_PRESETS.low;

	t.is(preset.name, "Low-End");
	t.true(
		preset.description.includes("Low-end"),
	);
	t.is(preset.threads, 4);
	t.is(preset.gpuLayers, 0);
	t.is(preset.ctxSize, 2048);
	t.is(preset.batchSize, 512);
	t.is(preset.maxTokens, 50);
});

test("Medium preset has correct configuration", (t) => {
	const preset: PresetConfig = BENCHMARK_PRESETS.medium;

	t.is(preset.name, "Medium");
	t.true(
		preset.description.includes("Mid-range"),
	);
	t.is(preset.threads, 8);
	t.is(preset.gpuLayers, 20);
	t.is(preset.ctxSize, 4096);
	t.is(preset.batchSize, 1024);
	t.is(preset.maxTokens, 100);
});

test("High preset has correct configuration", (t) => {
	const preset: PresetConfig = BENCHMARK_PRESETS.high;

	t.is(preset.name, "High-End");
	t.true(
		preset.description.includes("High-end"),
	);
	t.is(preset.threads, undefined);
	t.is(preset.gpuLayers, undefined);
	t.is(preset.ctxSize, 8192);
	t.is(preset.batchSize, 2048);
	t.is(preset.maxTokens, 150);
});

test("Ultra preset has correct configuration", (t) => {
	const preset: PresetConfig = BENCHMARK_PRESETS.ultra;

	t.is(preset.name, "Ultra");
	t.true(
		preset.description.includes("Maximum performance"),
	);
	t.is(preset.threads, undefined);
	t.is(preset.gpuLayers, undefined);
	t.is(preset.ctxSize, 16384);
	t.is(preset.batchSize, 4096);
	t.is(preset.maxTokens, 200);
});

test("Low preset uses CPU only (gpuLayers = 0)", (t) => {
	const preset = BENCHMARK_PRESETS.low;

	// When gpuLayers is 0, it means CPU only
	t.is(preset.gpuLayers, 0);

	// This should translate to cpuOnly: true in inference options
	const cpuOnly = preset.gpuLayers === 0;
	t.true(cpuOnly);
});

test("High and Ultra presets use auto settings (undefined)", (t) => {
	// These presets let llama.cpp decide optimal thread count and GPU layers
	t.is(BENCHMARK_PRESETS.high.threads, undefined);
	t.is(BENCHMARK_PRESETS.high.gpuLayers, undefined);
	t.is(BENCHMARK_PRESETS.ultra.threads, undefined);
	t.is(BENCHMARK_PRESETS.ultra.gpuLayers, undefined);
});

test("Context size increases with preset level", (t) => {
	t.is(BENCHMARK_PRESETS.low.ctxSize, 2048);
	t.is(BENCHMARK_PRESETS.medium.ctxSize, 4096);
	t.is(BENCHMARK_PRESETS.high.ctxSize, 8192);
	t.is(BENCHMARK_PRESETS.ultra.ctxSize, 16384);

	// Verify increasing order
	t.true(BENCHMARK_PRESETS.low.ctxSize < BENCHMARK_PRESETS.medium.ctxSize);
	t.true(BENCHMARK_PRESETS.medium.ctxSize < BENCHMARK_PRESETS.high.ctxSize);
	t.true(BENCHMARK_PRESETS.high.ctxSize < BENCHMARK_PRESETS.ultra.ctxSize);
});

test("Batch size increases with preset level", (t) => {
	t.is(BENCHMARK_PRESETS.low.batchSize, 512);
	t.is(BENCHMARK_PRESETS.medium.batchSize, 1024);
	t.is(BENCHMARK_PRESETS.high.batchSize, 2048);
	t.is(BENCHMARK_PRESETS.ultra.batchSize, 4096);

	// Verify increasing order
	t.true(BENCHMARK_PRESETS.low.batchSize < BENCHMARK_PRESETS.medium.batchSize);
	t.true(BENCHMARK_PRESETS.medium.batchSize < BENCHMARK_PRESETS.high.batchSize);
	t.true(BENCHMARK_PRESETS.high.batchSize < BENCHMARK_PRESETS.ultra.batchSize);
});

test("Max tokens increases with preset level", (t) => {
	t.is(BENCHMARK_PRESETS.low.maxTokens, 50);
	t.is(BENCHMARK_PRESETS.medium.maxTokens, 100);
	t.is(BENCHMARK_PRESETS.high.maxTokens, 150);
	t.is(BENCHMARK_PRESETS.ultra.maxTokens, 200);

	// Verify increasing order
	t.true(BENCHMARK_PRESETS.low.maxTokens < BENCHMARK_PRESETS.medium.maxTokens);
	t.true(BENCHMARK_PRESETS.medium.maxTokens < BENCHMARK_PRESETS.high.maxTokens);
	t.true(BENCHMARK_PRESETS.high.maxTokens < BENCHMARK_PRESETS.ultra.maxTokens);
});

test("Preset config type accepts valid configuration", (t) => {
	const customPreset: PresetConfig = {
		name: "Custom",
		description: "Custom preset for testing",
		threads: 6,
		gpuLayers: 10,
		ctxSize: 4096,
		batchSize: 1024,
		maxTokens: 75,
	};

	t.is(customPreset.name, "Custom");
	t.is(customPreset.threads, 6);
	t.is(customPreset.gpuLayers, 10);
});

test("Preset config works with undefined optional values", (t) => {
	const autoPreset: PresetConfig = {
		name: "Auto",
		description: "Auto-detect settings",
		threads: undefined,
		gpuLayers: undefined,
		ctxSize: 4096,
		batchSize: 2048,
		maxTokens: 100,
	};

	t.is(autoPreset.threads, undefined);
	t.is(autoPreset.gpuLayers, undefined);
	t.is(autoPreset.ctxSize, 4096);
});

test("BenchmarkPreset type accepts valid preset names", (t) => {
	// Type-level test - if this compiles, the types are correct
	const presets: BenchmarkPreset[] = ["low", "medium", "high", "ultra"];

	t.is(presets.length, 4);
	t.true(presets.includes("low"));
	t.true(presets.includes("medium"));
	t.true(presets.includes("high"));
	t.true(presets.includes("ultra"));
});
