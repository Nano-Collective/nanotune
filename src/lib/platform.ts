/**
 * Platform support checks.
 *
 * Nanotune's toolchain is Apple-Silicon-only: MLX has no CUDA/CPU fallback we
 * ship, and we only publish pre-built llama.cpp binaries for macOS arm64.
 * Commands assert this up front so users on other platforms get one clear
 * sentence instead of a pip resolver error or a "no matching asset" failure
 * several minutes into a run.
 */

export interface PlatformInfo {
	platform: string;
	arch: string;
}

export function isSupportedPlatform({platform, arch}: PlatformInfo): boolean {
	return platform === 'darwin' && arch === 'arm64';
}

export function unsupportedPlatformMessage({
	platform,
	arch,
}: PlatformInfo): string {
	return (
		`Nanotune requires macOS on Apple Silicon (arm64). Detected: ${platform}/${arch}.\n` +
		'Other platforms are not currently supported — track progress at https://github.com/Nano-Collective/nanotune.'
	);
}

/**
 * Throw with an actionable message when running on unsupported hardware.
 * Defaults to the current process but takes an override so it can be tested
 * without stubbing `process`.
 */
export function assertSupportedPlatform(
	info: PlatformInfo = {platform: process.platform, arch: process.arch},
): void {
	if (!isSupportedPlatform(info)) {
		throw new Error(unsupportedPlatformMessage(info));
	}
}
