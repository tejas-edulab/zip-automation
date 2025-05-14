import inquirer from "inquirer";
import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import os from "os";
import { exec } from "child_process";
import archiver from "archiver";
import directory from "inquirer-directory";
import pdf from "pdf-parse";

// Initialization
const CSV_LOG_FILE = "scan-log.csv";
const LOG_FILE = "scan-log.txt";
const PDF_REPORT_FILE = "pdf-report.csv";
let SCANNER_NAME, PC_NAME, SCANNED_FOLDER, COMPRESSED_FOLDER, READY_TO_UPLOAD_ZIPS;
const isWin = process.platform === "win32";
const gsPackage = isWin ? "gswin64c" : "gs";
const logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
inquirer.registerPrompt("directory", directory);

// CSV Logger
function logCsvEvent({ folder, file, status, action, message }) {
  const timestamp = new Date().toISOString();
  const row = `"${timestamp}","${SCANNER_NAME}","${PC_NAME}","${folder}","${file}","${status}","${action}","${message.replace(/"/g, '""')}"\n`;
  fs.appendFileSync(CSV_LOG_FILE, row);
}

// Ask for folders
async function promptForFolders() {
  const responses = await inquirer.prompt([
    {
      type: "input",
      name: "scanner",
      message: "🧍 Scanner Name / ID:",
      validate: (input) => input.trim() !== "" || "Scanner name required",
    },
    {
      type: "input",
      name: "pc",
      message: "💻 PC Name / No:",
      validate: (input) => input.trim() !== "" || "PC name required",
    },
    {
      type: "input",
      name: "scanned",
      message: "📥 Enter path for SCANNED_FOLDER:",
      validate: (input) => (fs.existsSync(input) && fs.lstatSync(input).isDirectory()) || "Invalid folder path",
    },
    {
      type: "input",
      name: "compressed",
      message: "📦 Enter path for COMPRESSED_FOLDER:",
      validate: (input) => (fs.existsSync(input) && fs.lstatSync(input).isDirectory()) || "Invalid folder path",
    },
    {
      type: "input",
      name: "ready",
      message: "🚀 Enter path for READY_TO_UPLOAD_ZIPS:",
      validate: (input) => (fs.existsSync(input) && fs.lstatSync(input).isDirectory()) || "Invalid folder path",
    },
  ]);

  SCANNED_FOLDER = responses.scanned;
  COMPRESSED_FOLDER = responses.compressed;
  READY_TO_UPLOAD_ZIPS = responses.ready;
  SCANNER_NAME = responses.scanner;
  PC_NAME = responses.pc;
}

// Plain logger
function logEvent(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}${os.EOL}`;
  console.log(logMessage.trim());
  logStream.write(logMessage);
}

// Compress PDF
function compressPDF(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Ghostscript command explanation:
    // - "gswin64c"            → Windows 64-bit console version of Ghostscript // If mac/linx use gs
    // - -sDEVICE=pdfwrite     → Output device set to PDF (we are generating a PDF)
    // - -dCompatibilityLevel=1.4 → Sets the PDF version (1.4 is widely compatible)
    // - -dPDFSETTINGS=/ebook  → Compression quality preset (good balance of quality and size)
    //   Other options: /screen (lower quality), /printer (higher quality), /prepress (highest), /default
    // - -dNOPAUSE             → Don't prompt and pause between pages
    // - -dQUIET               → Suppress routine information messages
    // - -dBATCH               → Exit after processing (no interactive mode)
    // - -sOutputFile=...      → Output file path
    // - inputPath             → Input file to compress
    const gsCmd = `"${gsPackage}" -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outputPath}" "${inputPath}"`;

    exec(gsCmd, (error, stdout, stderr) => {
      if (error) {
        reject(`Compression failed: ${error.message}`);
      } else {
        resolve();
      }
    });
  });
}

// Zip folder
function zipFolder(sourceFolder, zipFilePath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipFilePath);
    const archive = archiver("zip", {
      zlib: { level: 9 },
    });

    output.on("close", () => resolve());
    archive.on("error", (err) => reject(err));

    archive.pipe(output);
    archive.directory(sourceFolder, false);
    archive.finalize();
  });
}

// Wait for folder stability
function waitForFolderToStabilize(folderPath, durationMs = 3000, interval = 1000) {
  return new Promise((resolve) => {
    let previousCount = 0;
    let stableTime = 0;

    const intervalId = setInterval(() => {
      const files = fs.readdirSync(folderPath).filter((f) => f.toLowerCase().endsWith(".pdf"));
      const currentCount = files.length;

      if (currentCount === previousCount) {
        stableTime += interval;
        if (stableTime >= durationMs) {
          clearInterval(intervalId);
          resolve();
        }
      } else {
        previousCount = currentCount;
        stableTime = 0;
      }
    }, interval);
  });
}

// Enhanced PDF Report function with proper error handling
async function generatePDFReport(pdfPath) {
  try {
    if (!fs.existsSync(pdfPath)) {
      throw new Error("PDF file does not exist");
    }

    const dataBuffer = fs.readFileSync(pdfPath);

    let pdfData;
    try {
      pdfData = await pdf(dataBuffer, {
        max: 1, // Only process first page for quick metadata access
      });
    } catch (pdfError) {
      // If PDF parsing fails, continue with basic file info
      pdfData = {
        numpages: 0,
        info: {},
      };
      logEvent(`⚠️ PDF parsing warning for ${pdfPath}: ${pdfError.message}`);

      console.log(pdfError);
      throw new Error(pdfError);
    }

    const fileStats = fs.statSync(pdfPath);
    const fileSizeInMB = (fileStats.size / (1024 * 1024)).toFixed(2);
    const baseFolder = path.basename(path.dirname(pdfPath));
    const fileName = path.basename(pdfPath);

    console.log("PDF Data ", pdfData);

    const reportData = {
      timestamp: new Date().toISOString(),
      scannerName: SCANNER_NAME || "Unknown",
      pcName: PC_NAME || "Unknown",
      fileName: fileName,
      baseFolder: baseFolder,
      location: pdfPath,
      pageCount: pdfData.numpages || 0,
      fileSizeInMB: fileSizeInMB,
      title: pdfData.info?.Title || "N/A",
      author: pdfData.info?.Author || "N/A",
      creationDate: pdfData.info?.CreationDate || "N/A",
    };

    return reportData;
  } catch (error) {
    logEvent(`⚠️ Error generating PDF report for ${pdfPath}: ${error.message}`);
    // Return basic file information even if detailed PDF parsing fails
    const fileStats = fs.statSync(pdfPath);
    const fileSizeInMB = (fileStats.size / (1024 * 1024)).toFixed(2);
    return {
      timestamp: new Date().toISOString(),
      scannerName: SCANNER_NAME || "Unknown",
      pcName: PC_NAME || "Unknown",
      fileName: path.basename(pdfPath),
      baseFolder: path.basename(path.dirname(pdfPath)),
      location: pdfPath,
      pageCount: 0,
      fileSizeInMB: fileSizeInMB,
      title: "N/A",
      author: "N/A",
      creationDate: "N/A",
    };
  }
}

// Add function to save PDF report to CSV
function savePDFReport(reportData) {
  if (!reportData) return;

  const csvLine = `"${reportData.timestamp}","${reportData.scannerName}","${reportData.pcName}","${reportData.fileName}","${reportData.baseFolder}","${reportData.location}","${reportData.pageCount}","${reportData.fileSizeInMB}","${reportData.title}","${reportData.author}","${reportData.creationDate}"\n`;

  // Create header if file doesn't exist
  if (!fs.existsSync(PDF_REPORT_FILE)) {
    const header = "Timestamp,ScannerName,PCName,FileName,BaseFolder,Location,PageCount,FileSizeMB,Title,Author,CreationDate\n";
    fs.writeFileSync(PDF_REPORT_FILE, header);
  }

  fs.appendFileSync(PDF_REPORT_FILE, csvLine);
}

// Handle folder
async function handleNewFolder(folderPath) {
  logEvent(`📂 New folder detected: ${folderPath}`);
  logCsvEvent({ folder: folderPath, file: "", status: "Info", action: "Folder Detected", message: folderPath });

  await waitForFolderToStabilize(folderPath, 4000);

  const folderName = path.basename(folderPath);
  const compressedTargetPath = path.join(COMPRESSED_FOLDER, folderName);

  if (!fs.existsSync(compressedTargetPath)) {
    fs.mkdirSync(compressedTargetPath, { recursive: true });
  }

  const files = fs.readdirSync(folderPath);
  const pdfs = files.filter((f) => f.toLowerCase().endsWith(".pdf"));

  if (pdfs.length === 0) {
    logEvent(`⚠️ No PDFs found in ${folderPath}`);
    logCsvEvent({ folder: folderPath, file: "", status: "Fail", action: "No PDFs", message: "No PDF files found" });
    return;
  } else {
    logEvent(`📄 ${pdfs.length} PDF(s) found in ${folderPath}`);
    logCsvEvent({ folder: folderPath, file: "", status: "Pass", action: "PDFs Found", message: `${pdfs.length} PDFs` });
  }

  for (const file of pdfs) {
    const fullPath = path.join(folderPath, file);
    const outputPath = path.join(compressedTargetPath, file);

    try {
      // Generate and save PDF report before compression
      logEvent(`📊 Generating report for ${file}...`);

      const pdfReport = await generatePDFReport(fullPath);
      savePDFReport(pdfReport);

      logEvent(`📝 Report generated for ${file}`);

      logEvent(`🔄 Compressing ${file}...`);
      logCsvEvent({ folder: folderPath, file, status: "Info", action: "Compressing", message: fullPath });

      await compressPDF(fullPath, outputPath);

      logEvent(`✅ Compressed: ${outputPath}`);
      logCsvEvent({ folder: folderPath, file, status: "Pass", action: "Compressed", message: outputPath });
    } catch (err) {
      logEvent(`❌ Failed to process ${file}: ${err}`);
      logCsvEvent({ folder: folderPath, file, status: "Fail", action: "Processing Failed", message: err.toString() });
    }
  }

  const zipFileName = `${folderName}.zip`;
  const zipFilePath = path.join(READY_TO_UPLOAD_ZIPS, zipFileName);

  try {
    logEvent(`📦 Zipping compressed folder: ${compressedTargetPath}`);
    logCsvEvent({ folder: folderPath, file: zipFileName, status: "Info", action: "Zipping", message: compressedTargetPath });

    await zipFolder(compressedTargetPath, zipFilePath);

    logEvent(`✅ Zipped folder stored at: ${zipFilePath}`);
    logCsvEvent({ folder: folderPath, file: zipFileName, status: "Pass", action: "Zipped", message: zipFilePath });
  } catch (err) {
    logEvent(`❌ Failed to zip folder ${folderName}: ${err}`);
    logCsvEvent({ folder: folderPath, file: zipFileName, status: "Fail", action: "Zip Failed", message: err.toString() });
  }
}

// Main runner
const main = async () => {
  if (!fs.existsSync(CSV_LOG_FILE)) {
    fs.writeFileSync(CSV_LOG_FILE, "Timestamp,Scanner,PC,Folder,File,Status,Action,Message\n");
  }

  await promptForFolders();

  const watcher = chokidar.watch(SCANNED_FOLDER, {
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold: 10000,
      pollInterval: 500,
    },
  });

  watcher.on("addDir", (dirPath) => {
    handleNewFolder(dirPath);
  });

  watcher.on("error", (error) => {
    logEvent(`❌ Watcher error: ${error}`);
    logCsvEvent({ folder: SCANNED_FOLDER, file: "", status: "Fail", action: "Watcher Error", message: error.toString() });
  });

  logEvent(`📡 Watching folder: ${SCANNED_FOLDER}`);
  logCsvEvent({ folder: SCANNED_FOLDER, file: "", status: "Info", action: "Watcher Started", message: "Started watching scanned folder" });
};

main();
