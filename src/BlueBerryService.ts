import { window, workspace, ExtensionContext } from "vscode";
import { spawn } from "child_process";
import { LoggingService } from "./LoggingService.js";

export class BlueBerryService {
  private active = false;
  private secretStorage: ExtensionContext["secrets"];
  private currentLoopTask: Promise<void> | null = null;
  private requiredBinariesChecked = false;
  private activeTimeouts: Set<NodeJS.Timeout> = new Set();
  private startTime: number = 0;

  // Decoded command names
  private readonly LOCK_CMD = "ft_lock";
  private readonly XDOTOOL_CMD = "xdotool";
  private readonly XSET_CMD = "xset";
  private readonly XINPUT_CMD = "xinput";
  private readonly LOGINCTL_CMD = "loginctl";
  private readonly REQUIRED_BINARIES = [
    "ft_lock",
    "xdotool",
    "xset",
    "xinput",
    "loginctl",
  ];
  private readonly UNLOCK_TIME_MS = 500; // Fixed 0.5 second unlock time

  constructor(
    secretStorage: ExtensionContext["secrets"],
    private loggingService: LoggingService,
  ) {
    this.secretStorage = secretStorage;
  }

  private logCommand(cmd: string, args: string[] = []): void {
    const fullCommand = `${cmd} ${args.join(" ")}`;
    this.loggingService.logInfo(`[BlueBerry] Would execute: ${fullCommand}`);
  }

  private isDryRun(): boolean {
    const config = workspace.getConfiguration("blueberry");
    return config.get<boolean>("dryRun") ?? false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.activeTimeouts.delete(timeoutId);
        resolve();
      }, ms);
      this.activeTimeouts.add(timeoutId);
    });
  }

  private parseDuration(duration: string): number {
    // Parse duration string like "1h", "30m", "90s", "1.5h"
    const match = duration.trim().match(/^([\d.]+)([hms])$/i);
    if (!match) {
      this.loggingService.logError(
        `Invalid duration format: "${duration}". Using default 1 hour.`,
      );
      return 60 * 60 * 1000; // Default to 1 hour
    }

    const value = parseFloat(match[1]);
    const unit = match[2].toLowerCase();

    switch (unit) {
      case "h":
        return value * 60 * 60 * 1000; // hours to ms
      case "m":
        return value * 60 * 1000; // minutes to ms
      case "s":
        return value * 1000; // seconds to ms
      default:
        return 60 * 60 * 1000; // Default to 1 hour
    }
  }

  private async checkBinaryExists(binaryName: string): Promise<boolean> {
    if (this.isDryRun()) {
      this.logCommand("which", [binaryName]);
      // In dry-run mode, assume binaries exist to allow testing
      return true;
    }

    try {
      const result = await this.execAndWaitForOutput("which", [binaryName]);
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async checkRequiredBinaries(): Promise<{
    allPresent: boolean;
    missing: string[];
  }> {
    const missing: string[] = [];

    for (const binary of this.REQUIRED_BINARIES) {
      const exists = await this.checkBinaryExists(binary);
      if (!exists) {
        missing.push(binary);
      }
    }

    return {
      allPresent: missing.length === 0,
      missing,
    };
  }

  private runCommandAsync(
    cmd: string,
    args: string[] = [],
  ): Promise<number | null> {
    if (this.isDryRun()) {
      this.logCommand(cmd, args);
      return Promise.resolve(0); // Success in dry-run mode
    }

    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        env: process.env,
        shell: false,
        stdio: "inherit",
      });
      child.on("error", reject);
      child.on("exit", resolve);
    });
  }

  private execAndWaitForOutput(
    cmd: string,
    args: string[] = [],
  ): Promise<string> {
    if (this.isDryRun()) {
      this.logCommand(cmd, args);
      // Return mock output for dry-run mode
      if (cmd === this.XINPUT_CMD && args[0] === "list") {
        return Promise.resolve(
          `⎡ Virtual core pointer                    	id=2	[master pointer  (3)]
⎜   ↳ Virtual core XTEST pointer              	id=4	[slave  pointer  (2)]
⎜   ↳ Logitech USB Mouse                       	id=9	[slave  pointer  (2)]
⎣ Virtual core keyboard                   	id=3	[master keyboard (2)]
    ↳ Virtual core XTEST keyboard             	id=5	[slave  keyboard (3)]
    ↳ AT Translated Set 2 wired keyboard      	id=10	[slave  keyboard (3)]`,
        );
      }
      if (
        cmd === this.LOGINCTL_CMD &&
        args[0] === "list-sessions" &&
        args[1] === "--no-legend"
      ) {
        return Promise.resolve("c54 103457 abennar seat0");
      }
      return Promise.resolve("");
    }

    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        env: process.env,
        shell: false,
        stdio: "pipe",
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("error", reject);

      child.on("exit", (code) => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(stderr || `Command exited with code ${code}`));
        }
      });
    });
  }

  private async disableInputDevices(deviceIds: number[]): Promise<void> {
    for (const id of deviceIds) {
      try {
        await this.runCommandAsync(this.XINPUT_CMD, ["disable", id.toString()]);
      } catch {
        // Ignore errors
      }
    }
  }

  private async enableInputDevices(deviceIds: number[]): Promise<void> {
    for (const id of deviceIds) {
      try {
        await this.runCommandAsync(this.XINPUT_CMD, ["enable", id.toString()]);
      } catch {
        // Ignore errors
      }
    }
  }

  private async getKeyboardIds(): Promise<number[]> {
    try {
      const output = await this.execAndWaitForOutput(this.XINPUT_CMD, ["list"]);
      const lines = output.split("\n");
      const keyboardIds: number[] = [];

      for (const line of lines) {
        if (
          line.includes("slave  keyboard") &&
          line.includes("wired keyboard")
        ) {
          const match = line.match(/id=(\d+)/);
          if (match) {
            keyboardIds.push(parseInt(match[1]));
          }
        }
      }

      return keyboardIds;
    } catch (error) {
      this.loggingService.logError("Error getting keyboard IDs:", error);
      return [];
    }
  }

  private async getMouseIds(): Promise<number[]> {
    try {
      const output = await this.execAndWaitForOutput(this.XINPUT_CMD, ["list"]);
      const lines = output.split("\n");
      const mouseIds: number[] = [];

      for (const line of lines) {
        if (
          line.includes("slave  pointer") &&
          (line.includes("Mouse") || line.includes("mouse"))
        ) {
          const match = line.match(/id=(\d+)/);
          if (match) {
            mouseIds.push(parseInt(match[1]));
          }
        }
      }

      return mouseIds;
    } catch (error) {
      this.loggingService.logError("Error getting mouse IDs:", error);
      return [];
    }
  }

  private validateLockIntervals(
    minMs: number,
    maxMs: number,
  ): { valid: boolean; error?: string } {
    const MAX_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes in milliseconds

    if (minMs > MAX_INTERVAL_MS) {
      return {
        valid: false,
        error: `Minimum lock interval exceeds 30 minutes limit`,
      };
    }

    if (maxMs > MAX_INTERVAL_MS) {
      return {
        valid: false,
        error: `Maximum lock interval exceeds 30 minutes limit`,
      };
    }

    if (minMs > maxMs) {
      return {
        valid: false,
        error: `Minimum lock interval (${minMs}ms) cannot be greater than maximum (${maxMs}ms)`,
      };
    }

    return { valid: true };
  }

  private getRandomLockInterval(minMs: number, maxMs: number): number {
    // If min === max, return exact value (no randomness)
    if (minMs === maxMs) {
      return minMs;
    }
    // Otherwise, return random value between min and max
    return Math.random() * (maxMs - minMs) + minMs;
  }

  private async getCurrentSessionId(): Promise<string | null> {
    try {
      const output = await this.execAndWaitForOutput(this.LOGINCTL_CMD, [
        "list-sessions",
        "--no-legend",
      ]);

      this.loggingService.logInfo(`[BlueBerry] loginctl output: "${output}"`);

      // Output format: "c54 103457 abennar seat0"
      const lines = output.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          const parts = trimmed.split(/\s+/);
          if (parts.length >= 1) {
            this.loggingService.logInfo(
              `[BlueBerry] Found session ID: ${parts[0]}`,
            );
            return parts[0]; // Return session ID (first column)
          }
        }
      }

      this.loggingService.logError(
        "[BlueBerry] No session found in loginctl output",
      );
      return null;
    } catch (error) {
      this.loggingService.logError(
        `[BlueBerry] Error executing loginctl: ${error}`,
      );
      return null;
    }
  }

  private async terminateSession(): Promise<void> {
    const sessionId = await this.getCurrentSessionId();
    if (!sessionId) {
      this.loggingService.logError("Could not get session ID for logout");
      return;
    }

    this.loggingService.logInfo(
      `[BlueBerry] Terminating session: ${sessionId}`,
    );
    await this.runCommandAsync(this.LOGINCTL_CMD, [
      "terminate-session",
      sessionId,
    ]);
  }

  private hasTimeExpired(durationMs: number): boolean {
    const elapsedMs = Date.now() - this.startTime;
    return elapsedMs >= durationMs;
  }

  private async loopTask(): Promise<void> {
    const secret = (await this.secretStorage.get("blueberry-secret"))?.trim();

    // If secret is missing during execution, stop
    if (!secret || !this.active) {
      return;
    }

    const config = workspace.getConfiguration("blueberry");
    const dryRun = this.isDryRun();
    const duration = config.get<string>("duration") ?? "1h";
    const durationMs = this.parseDuration(duration);
    const lockIntervalMinStr = config.get<string>("lockIntervalMin") ?? "10m";
    const lockIntervalMaxStr = config.get<string>("lockIntervalMax") ?? "20m";

    const lockIntervalMinMs = this.parseDuration(lockIntervalMinStr);
    const lockIntervalMaxMs = this.parseDuration(lockIntervalMaxStr);

    // Validate lock intervals
    const validation = this.validateLockIntervals(
      lockIntervalMinMs,
      lockIntervalMaxMs,
    );
    if (!validation.valid) {
      this.loggingService.logError(
        `[BlueBerry] Lock interval validation failed: ${validation.error}`,
      );
      await this.stop();
      window.showErrorMessage(
        `BlueBerry stopped: ${validation.error}. Please check your settings.`,
      );
      return;
    }

    // Check if time has expired
    if (this.hasTimeExpired(durationMs)) {
      this.loggingService.logInfo(
        `[BlueBerry] Duration of ${duration} expired. Logging out...`,
      );
      await this.terminateSession();
      void this.stop();
      window.showInformationMessage(
        `BlueBerry finished after ${duration}. Logged out.`,
      );
      return;
    }

    // Calculate random lock interval
    const lockIntervalMs = this.getRandomLockInterval(
      lockIntervalMinMs,
      lockIntervalMaxMs,
    );
    const lockIntervalMinutes = (lockIntervalMs / 1000 / 60).toFixed(2);

    if (dryRun) {
      this.loggingService.logInfo(`[BlueBerry] ===== New cycle started =====`);
      this.loggingService.logInfo(
        `[BlueBerry] Next lock in ${lockIntervalMinutes} minutes`,
      );
    }

    // Get device IDs before disabling
    const mouseIds = await this.getMouseIds();
    const keyboardIds = await this.getKeyboardIds();

    if (dryRun) {
      this.loggingService.logInfo(
        `[BlueBerry] Found ${mouseIds.length} mouse(s): ${mouseIds.join(", ")}`,
      );
      this.loggingService.logInfo(
        `[BlueBerry] Found ${keyboardIds.length} keyboard(s): ${keyboardIds.join(", ")}`,
      );
    }

    // Lock screen and turn off display
    await this.runCommandAsync(this.LOCK_CMD);
    void this.runCommandAsync(this.XSET_CMD, ["dpms", "force", "off"]);

    // Sleep for the random interval
    if (dryRun) {
      this.loggingService.logInfo(
        `[BlueBerry] Sleeping for ${lockIntervalMinutes} minutes...`,
      );
    }
    await this.sleep(lockIntervalMs);

    // Check if we were stopped during sleep
    if (!this.active) {
      return;
    }

    void this.runCommandAsync(this.XSET_CMD, ["dpms", "force", "off"]);

    // Disable input devices
    await this.disableInputDevices(mouseIds);
    await this.disableInputDevices(keyboardIds);

    // Unlock by typing password
    await this.runCommandAsync(this.LOCK_CMD);
    await this.runCommandAsync(this.XDOTOOL_CMD, ["type", secret]);
    void this.runCommandAsync(this.XSET_CMD, ["dpms", "force", "off"]);
    await this.runCommandAsync(this.XDOTOOL_CMD, ["key", "Return"]);
    void this.runCommandAsync(this.XSET_CMD, ["dpms", "force", "off"]);

    // Fixed 0.5s unlock time
    if (dryRun) {
      this.loggingService.logInfo(
        `[BlueBerry] Unlocked for ${this.UNLOCK_TIME_MS}ms...`,
      );
    }
    await this.sleep(this.UNLOCK_TIME_MS);

    // Check if we were stopped during sleep
    if (!this.active) {
      return;
    }

    void this.runCommandAsync(this.XSET_CMD, ["dpms", "force", "off"]);

    // Re-enable input devices
    await this.enableInputDevices(mouseIds);
    await this.enableInputDevices(keyboardIds);

    if (dryRun) {
      this.loggingService.logInfo(`[BlueBerry] ===== Cycle completed =====`);
    }

    // Continue to next cycle if still active
    if (this.active) {
      this.currentLoopTask = this.loopTask();
    }
  }
  async start(): Promise<void> {
    const dryRun = this.isDryRun();

    // Check if required binaries exist
    if (!this.requiredBinariesChecked) {
      const { allPresent, missing } = await this.checkRequiredBinaries();
      if (!allPresent && !dryRun) {
        window.showErrorMessage(
          `BlueBerry cannot start: Missing required system binaries: ${missing.join(", ")}. ` +
            `Please install them first.`,
        );
        return;
      }
      this.requiredBinariesChecked = true;
    }

    // Check if secret is set BEFORE starting
    const secret = (await this.secretStorage.get("blueberry-secret"))?.trim();
    if (!secret) {
      const action = await window.showErrorMessage(
        "BlueBerry cannot start: Secret is not set. Please set your password to continue.",
        "Set Secret Now",
        "Cancel",
      );

      if (action === "Set Secret Now") {
        await this.setSecret();
        window.showInformationMessage(
          "Secret set! Please start BlueBerry again.",
        );
      }
      return; // Don't start without a secret
    }

    if (!this.active) {
      this.active = true;
      this.startTime = Date.now(); // Record start time

      const config = workspace.getConfiguration("blueberry");
      const duration = config.get<string>("duration") ?? "1h";
      const lockIntervalMinStr = config.get<string>("lockIntervalMin") ?? "10m";
      const lockIntervalMaxStr = config.get<string>("lockIntervalMax") ?? "20m";

      const lockIntervalMinMs = this.parseDuration(lockIntervalMinStr);
      const lockIntervalMaxMs = this.parseDuration(lockIntervalMaxStr);

      // Validate lock intervals before starting
      const validation = this.validateLockIntervals(
        lockIntervalMinMs,
        lockIntervalMaxMs,
      );
      if (!validation.valid) {
        window.showErrorMessage(
          `BlueBerry cannot start: ${validation.error}. Please check your settings.`,
        );
        return;
      }

      if (dryRun) {
        this.loggingService.logInfo("========================================");
        this.loggingService.logInfo("[BlueBerry] Starting in DRY-RUN mode");
        this.loggingService.logInfo(`[BlueBerry] Duration: ${duration}`);
        this.loggingService.logInfo(
          `[BlueBerry] Lock interval: ${lockIntervalMinStr}-${lockIntervalMaxStr}`,
        );
        this.loggingService.logInfo("========================================");
      }

      // Initial lock only - no xset dpms, no input device manipulation
      if (dryRun) {
        this.loggingService.logInfo("[BlueBerry] Initial lock");
      }
      await this.runCommandAsync(this.LOCK_CMD);

      // Start the main loop task
      this.currentLoopTask = this.loopTask();
      window.showInformationMessage(
        `BlueBerry started${dryRun ? " (DRY-RUN)" : ""}. Will run for ${duration} with ${lockIntervalMinStr}-${lockIntervalMaxStr} intervals.`,
      );
    }
  }

  async stop(): Promise<void> {
    this.loggingService.logInfo("[BlueBerry] Stop requested");
    this.active = false;

    // Clear all active timeouts immediately
    const timeoutCount = this.activeTimeouts.size;
    this.loggingService.logInfo(
      `[BlueBerry] Clearing ${timeoutCount} active timeout(s)`,
    );
    for (const timeoutId of this.activeTimeouts) {
      clearTimeout(timeoutId);
    }
    this.activeTimeouts.clear();
    this.loggingService.logInfo("[BlueBerry] All timeouts cleared");

    // Don't wait for the loop task - just mark it as null
    if (this.currentLoopTask) {
      this.loggingService.logInfo(
        "[BlueBerry] Loop task is running but we're not waiting for it",
      );
      this.currentLoopTask = null;
    }

    this.loggingService.logInfo("[BlueBerry] Stopped successfully");
    window.showInformationMessage("BlueBerry is stopped.");
  }

  async setSecret(): Promise<void> {
    const pw = await window.showInputBox({
      prompt: "Enter your password",
      password: true,
    });
    if (pw) {
      const trimmed = pw.trim();
      await this.secretStorage.store("blueberry-secret", trimmed);
      window.showInformationMessage("Password updated securely.");
    }
  }

  async clearSecret(): Promise<void> {
    await this.secretStorage.delete("blueberry-secret");
    window.showInformationMessage("BlueBerry secret has been cleared.");
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}
