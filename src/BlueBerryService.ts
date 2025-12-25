import { window, workspace, ExtensionContext } from "vscode";
import { spawn } from "child_process";
import { LoggingService } from "./LoggingService.js";

export class BlueBerryService {
  private active = false;
  private secretStorage: ExtensionContext["secrets"];
  private currentLoopTask: Promise<void> | null = null;
  private requiredBinariesChecked = false;
  private activeTimeouts: Set<NodeJS.Timeout> = new Set();

  // Decoded command names
  private readonly LOCK_CMD = "ft_lock";
  private readonly XDOTOOL_CMD = "xdotool";
  private readonly XSET_CMD = "xset";
  private readonly XINPUT_CMD = "xinput";
  private readonly REQUIRED_BINARIES = ["ft_lock", "xdotool", "xset", "xinput"];

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

  private async loopTask(cyclesLeft: number): Promise<void> {
    const secret = (await this.secretStorage.get("blueberry-secret"))?.trim();

    // If secret is missing during execution, stop (shouldn't happen since we check in start())
    if (!secret || !this.active || cyclesLeft <= 0) {
      if (cyclesLeft <= 0) {
        await this.runCommandAsync(this.LOCK_CMD);
        void this.stop();
        window.showInformationMessage("BlueBerry finished all cycles.");
      }
      return;
    }

    const config = workspace.getConfiguration("blueberry");
    const dryRun = this.isDryRun();

    const wait1 = config.get<number>("napTimeS") ?? 1800;
    const wait2 = config.get<number>("weakTimeS") ?? 0.5;
    const stopAfterCycles = config.get<number>("stopAfterCycles") ?? 0;

    if (dryRun) {
      const cycleNum =
        stopAfterCycles > 0 ? stopAfterCycles - cyclesLeft + 1 : "∞";
      this.loggingService.logInfo(
        `[BlueBerry] ===== Cycle ${cycleNum} started =====`,
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

    // Full cycle logic: lock, turn off display, sleep, unlock
    await this.runCommandAsync(this.LOCK_CMD);
    void this.runCommandAsync(this.XSET_CMD, ["dpms", "force", "off"]);

    if (dryRun) {
      this.loggingService.logInfo(
        `[BlueBerry] Sleeping for ${wait1}s (napTimeS)...`,
      );
    }
    await this.sleep(wait1 * 1000);

    // Check if we were stopped during sleep
    if (!this.active) {
      return;
    }

    void this.runCommandAsync(this.XSET_CMD, ["dpms", "force", "off"]);

    await this.disableInputDevices(mouseIds);
    await this.disableInputDevices(keyboardIds);

    await this.runCommandAsync(this.LOCK_CMD);
    await this.runCommandAsync(this.XDOTOOL_CMD, ["type", secret]);
    void this.runCommandAsync(this.XSET_CMD, ["dpms", "force", "off"]);
    await this.runCommandAsync(this.XDOTOOL_CMD, ["key", "Return"]);
    void this.runCommandAsync(this.XSET_CMD, ["dpms", "force", "off"]);

    if (dryRun) {
      this.loggingService.logInfo(
        `[BlueBerry] Sleeping for ${wait2}s (weakTimeS)...`,
      );
    }
    await this.sleep(wait2 * 1000);

    // Check if we were stopped during sleep
    if (!this.active) {
      return;
    }

    void this.runCommandAsync(this.XSET_CMD, ["dpms", "force", "off"]);

    await this.enableInputDevices(mouseIds);
    await this.enableInputDevices(keyboardIds);

    if (dryRun) {
      this.loggingService.logInfo(`[BlueBerry] ===== Cycle completed =====`);
    }

    if (this.active) {
      if (stopAfterCycles > 0) {
        this.currentLoopTask = this.loopTask(cyclesLeft - 1);
      } else {
        this.currentLoopTask = this.loopTask(cyclesLeft);
      }
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

      const config = workspace.getConfiguration("blueberry");
      const stopAfterCycles = config.get<number>("stopAfterCycles") ?? 0;

      if (dryRun) {
        this.loggingService.logInfo("========================================");
        this.loggingService.logInfo("[BlueBerry] Starting in DRY-RUN mode");
        this.loggingService.logInfo(
          `[BlueBerry] Cycles: ${stopAfterCycles || "infinite"}`,
        );
        this.loggingService.logInfo("========================================");
      }

      // Initial lock only - no xset dpms, no input device manipulation
      if (dryRun) {
        this.loggingService.logInfo("[BlueBerry] Initial lock");
      }
      await this.runCommandAsync(this.LOCK_CMD);

      // Start the main loop task
      this.currentLoopTask = this.loopTask(stopAfterCycles || Infinity);
      window.showInformationMessage(
        stopAfterCycles > 0
          ? `BlueBerry started${dryRun ? " (DRY-RUN)" : ""}. Will stop after ${stopAfterCycles} cycles.`
          : `BlueBerry started${dryRun ? " (DRY-RUN)" : ""} (infinite cycles).`,
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
