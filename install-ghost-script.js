import os from 'os';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';
import { exec, execSync } from 'child_process';
import { pipeline } from 'stream';
import { promisify } from 'util';

const streamPipeline = promisify(pipeline);
const platform = os.platform();

async function installGhostscript() {
  if (platform === 'win32') {
    await installGhostscriptWindows();
  } else if (platform === 'darwin') {
    await installGhostscriptMac();
  } else if (platform === 'linux') {
    await installGhostscriptLinux();
  } else {
    console.log(`❌ Unsupported OS: ${platform}`);
  }
}

// -------------------- WINDOWS --------------------

async function installGhostscriptWindows() {
  const gsUrl = 'https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/latest/download/gs10060w64.exe'; // Example version
  const installerPath = path.join(os.tmpdir(), 'gs_installer.exe');

  console.log(`⬇ Downloading Ghostscript for Windows...`);
  const response = await fetch(gsUrl);
  if (!response.ok) throw new Error(`Failed to download: ${response.statusText}`);
  await streamPipeline(response.body, fs.createWriteStream(installerPath));

  console.log(`📦 Running Ghostscript installer silently...`);
  execSync(`"${installerPath}" /S`, { stdio: 'inherit' });

  console.log(`✅ Ghostscript installed. Make sure 'gswin64c' is in PATH or use full path.`);
}

// -------------------- MAC --------------------

async function installGhostscriptMac() {
  try {
    console.log(`📦 Installing Ghostscript via Homebrew...`);
    execSync(`brew install ghostscript`, { stdio: 'inherit' });
    console.log(`✅ Ghostscript installed.`);
  } catch (err) {
    console.error(`❌ Failed: ${err.message}`);
    console.log(`💡 You may need to install Homebrew first: https://brew.sh`);
  }
}

// -------------------- LINUX --------------------

async function installGhostscriptLinux() {
  try {
    console.log(`📦 Installing Ghostscript via apt...`);
    execSync(`sudo apt-get update && sudo apt-get install -y ghostscript`, { stdio: 'inherit' });
    console.log(`✅ Ghostscript installed.`);
  } catch (err) {
    console.error(`❌ Failed: ${err.message}`);
    console.log(`💡 Make sure you're on Debian/Ubuntu or install via your distro's package manager.`);
  }
}

// Run installer
installGhostscript().catch(err => {
  console.error(`❌ Installation failed: ${err.message}`);
});
