# BlueBerry Testing Mode

The BlueBerry service now includes a **dry-run mode** that allows you to test the service without executing actual system commands.

## Configuration

### `blueberry.dryRun` (default: `true`)

When enabled, all system commands are logged to a dedicated terminal called "BlueBerry Debug" instead of being executed. This allows you to:

- See exactly what commands would be run
- Test the service logic without requiring system binaries
- Debug the service behavior safely

## How It Works

### In Dry-Run Mode (default)

1. All binary calls (`ft_lock`, `xdotool`, `xset`, `xinput`) are logged to the terminal
2. Mock data is provided for commands that need output (like `xinput list`)
3. A terminal window shows all command execution with timestamps and cycle information
4. Required system binaries are assumed to be present (no installation needed for testing)

### In Production Mode (`blueberry.dryRun: false`)

1. All commands are executed normally
2. System binaries must be installed: `ft_lock`, `xdotool`, `xset`, `xinput`
3. The service checks for binary availability before starting
4. All operations affect the actual system

## Usage

### Enable Dry-Run Mode (Testing)

Add to your VS Code settings (`.vscode/settings.json`):

```json
{
  "blueberry.dryRun": true
}
```

Or use the command palette:

1. Open Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`)
2. Type: `Preferences: Open Settings (JSON)`
3. Add the setting above

### Disable Dry-Run Mode (Production)

```json
{
  "blueberry.dryRun": false
}
```

**⚠️ Warning**: Only disable dry-run mode if you have the required system binaries installed and understand what the service does.

## Terminal Output Example

When running in dry-run mode, you'll see output like:

```bash
========================================
[BlueBerry] Starting in DRY-RUN mode
[BlueBerry] Cycles: 5
========================================

[BlueBerry] ===== Cycle 1 started at Tue Dec 24 10:00:00 PST 2025 =====
[BlueBerry] Would execute: which ft_lock
[BlueBerry] Would execute: which xdotool
[BlueBerry] Would execute: which xset
[BlueBerry] Would execute: which xinput
[BlueBerry] Would execute: xinput list
[BlueBerry] Found 1 mouse(s): 9
[BlueBerry] Found 1 keyboard(s): 10
[BlueBerry] Would execute: ft_lock
[BlueBerry] Would execute: xset dpms force off
[BlueBerry] Sleeping for 1800s (napTimeS)...
[BlueBerry] Would execute: xset dpms force off
[BlueBerry] Would execute: xinput disable 9
[BlueBerry] Would execute: xinput disable 10
[BlueBerry] Would execute: ft_lock
[BlueBerry] Would execute: xdotool type ***
[BlueBerry] Would execute: xset dpms force off
[BlueBerry] Would execute: xdotool key Return
[BlueBerry] Would execute: xset dpms force off
[BlueBerry] Sleeping for 0.5s (weakTimeS)...
[BlueBerry] Would execute: xset dpms force off
[BlueBerry] Would execute: xinput enable 9
[BlueBerry] Would execute: xinput enable 10
[BlueBerry] ===== Cycle completed at Tue Dec 24 10:30:00 PST 2025 =====
```

## Testing Scenarios

### Test 1: Basic Start/Stop

```typescript
// Start the service
Command: "Start BlueBerry";

// Check the terminal for logged commands
// Stop the service
Command: "Stop BlueBerry";
```

### Test 2: Test with Different Configuration

```json
{
  "blueberry.dryRun": true,
  "blueberry.napTimeS": 5,
  "blueberry.weakTimeS": 1,
  "blueberry.stopAfterCycles": 3
}
```

Start BlueBerry and watch the terminal show 3 cycles with 5-second naps.

### Test 3: Verify Command Sequence

Check the terminal output to ensure the command sequence is correct:

1. Lock screen
2. Disable input devices
3. Type password
4. Press Enter
5. Enable input devices

## Benefits

- **Safe Testing**: No risk of accidentally locking your system or disabling devices
- **Development**: Easily test changes to the service logic
- **Debugging**: See exactly what commands are being executed
- **Documentation**: The terminal output serves as documentation of what the service does
- **No Dependencies**: Test without installing system binaries

## Switching to Production

Once you've tested and are confident the service works as expected:

1. Install required system binaries:

   ```bash
   # Example for Ubuntu/Debian
   sudo apt-get install xdotool xset xinput
   # Install ft_lock from your 42 school tools
   ```

2. Update your settings:

   ```json
   {
     "blueberry.dryRun": false
   }
   ```

3. Restart the BlueBerry service

The service will now execute actual commands instead of logging them.
