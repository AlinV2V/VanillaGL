# How to install and play VanillaGL

This guide is for players. No programming knowledge is needed: you double-click two files and answer a few questions.

VanillaGL lets you play World of Warcraft 1.12.1 (Vanilla) **in your web browser**. It does not include the game itself. It converts the files of a WoW client that you already have into a format your browser can use.

---

## What you need

| | |
| --- | --- |
| **A computer** | Windows 10 or 11 (easiest), macOS or Linux. |
| **A web browser** | Google Chrome or Microsoft Edge recommended (Firefox also works). |
| **Free disk space** | About **25 GB** for the recommended world size. |
| **Your own WoW 1.12.1 client** | The original Vanilla client, version **1.12.1 (build 5875)**. You can check the version in the bottom-left corner of the original game's login screen. VanillaGL does not provide or download it. |
| **A server to play on** | A [vMaNGOS](https://github.com/vmangos/core) server. Either someone gives you a server address plus an account, or you run your own (see [vMaNGOS](https://github.com/vmangos/core) for how). |
| **About an hour** | Only the first time, while your game files are converted. |

---

## Windows

### Step 1: Download VanillaGL

1. On the [VanillaGL GitHub page](https://github.com/AlinV2V/VanillaGL), click the green **Code** button, then **Download ZIP**.
2. Right-click the downloaded ZIP, choose **Extract All...**, and extract it to a simple folder such as `C:\Games\VanillaGL`.

> Avoid extracting into OneDrive, Dropbox, Google Drive or `Program Files`. Synced folders try to upload the converted game files (many gigabytes), and `Program Files` blocks writing.

### Step 2: Run Setup

1. Open the extracted folder and double-click **`Setup.bat`**.
2. If Windows shows **"Windows protected your PC"**, click **More info**, then **Run anyway**. (Setup.bat is a short text file; you can open it in Notepad to see what it does.)
3. **If you don't have Node.js** (the program VanillaGL runs on), Setup offers to install it for you. Press **Y**. When it finishes, close the window and double-click `Setup.bat` again.

Setup then asks you three things:

1. **Where your WoW client is.** Drag your WoW folder (the one containing `WoW.exe`) into the black window and press **Enter**. Typing or pasting the path works too, for example `C:\Games\World of Warcraft 1.12.1`.
2. **How much of the world to prepare.** Press **Enter** for the recommended choice (levels 1-40). Choose **1** if you are short on disk space or just want to try it out.
3. **Which server you play on.** Type the server address you were given, or just press **Enter** if the server runs on this same computer. Press **Enter** for the two port questions unless your server owner told you different numbers.

Answer **Y** to start. Setup now works on its own:

- The first time takes **about an hour**. Leave the window open; you can use your computer meanwhile.
- If anything interrupts it (closing the window, a restart, an error), just double-click `Setup.bat` again. It continues where it stopped and does not redo finished work.

When it says **All done**, press **Enter** to start the game.

### Step 3: Play

Double-click **`Play.bat`**. Your browser opens the game. Log in with your account on the server.

- **Keep the black Play window open while you play.** It connects your browser to the server.
- To stop, close the browser tab, then close the black window (or press **Ctrl+C** in it).
- Next time, just double-click `Play.bat` again. Setup is only needed once.

---

## macOS and Linux

1. Install Node.js (the **LTS** version) from [nodejs.org](https://nodejs.org), or with your package manager.
2. Download and extract VanillaGL as in Windows Step 1.
3. Open **Terminal**, type `cd ` (with a space), drag the VanillaGL folder into the Terminal window, and press **Enter**.
4. Run `bash setup.sh` and answer the questions as described in Windows Step 2.
5. To play, run `bash play.sh` from the same folder.

---

## Problems and questions

**"No .MPQ archives found"**
You picked the wrong folder. Choose the folder that contains `WoW.exe` and a `Data` folder full of `.MPQ` files.

**"... is missing: terrain.mpq" (or another file)**
Your client is incomplete or is not version 1.12.1. VanillaGL needs a complete 1.12.1 client.

**Setup stopped with an error**
Double-click `Setup.bat` again; it resumes. If the same error keeps appearing, [open an issue](https://github.com/AlinV2V/VanillaGL/issues) and paste the last 20 or so lines from the window.

**Not enough disk space**
Free some space, or run Setup again and choose **1) Starter**, the smallest world.

**The game opens but I can't log in**
- Is the server running, and is the address right? Run `Setup.bat` again, answer **N** to "Run the bake again", and re-enter the server address and ports.
- Is the black Play window still open?
- Is your username and password correct for **that server**? Accounts are created by the server owner.

**"address already in use" in the Play window, or the game opens twice**
Another Play window is already running. Close all black VanillaGL windows and start `Play.bat` once.

**Black screen, very slow, or graphical glitches**
Use an up-to-date Chrome or Edge, update your graphics drivers, and lower the graphics settings in the in-game Options menu.

**I want a bigger (or smaller) world later**
Run `Setup.bat` again and answer **Y** to "Run the bake again", then choose another size.

**Does this change my original WoW installation?**
No. Setup only reads your client and works on copies inside the VanillaGL folder.

**How do I uninstall it?**
Delete the VanillaGL folder. Everything, including the converted game files, lives inside it. Node.js can be removed through Windows **Settings > Apps** if you no longer need it.
