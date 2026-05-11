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
  console.log(`🔍 Fetching latest Ghostscript release info...`);

  // Get latest release metadata from GitHub API
  const apiRes = await fetch('https://api.github.com/repos/ArtifexSoftware/ghostpdl-downloads/releases/latest', {
    headers: { 'User-Agent': 'ghostscript-installer' },
  });
  if (!apiRes.ok) throw new Error(`GitHub API error: ${apiRes.statusText}`);
  const release = await apiRes.json();

  // Find the Windows 64-bit installer asset (matches gs*w64.exe)
  const asset = release.assets.find(a => /gs\w+w64\.exe$/i.test(a.name));
  if (!asset) throw new Error(`Could not find Windows 64-bit installer in release: ${release.tag_name}`);

  console.log(`⬇ Downloading ${asset.name} (${release.tag_name})...`);
  const installerPath = path.join(os.tmpdir(), asset.name);

  const response = await fetch(asset.browser_download_url);
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
