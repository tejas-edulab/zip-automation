import inquirer from "inquirer";
import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import os from "os";
import { exec } from "child_process";
import archiver from "archiver";
import directory from "inquirer-directory";
import pdf from "pdf-parse";
import dns from "node:dns";

// Initialization
const CSV_LOG_FILE = "scan-log.csv";
const LOG_FILE = "scan-log.txt";
const PDF_REPORT_FILE = "pdf-report.csv";
const MAX_FILES_PER_UPLOAD = 5; // Maximum files to upload in one batch
let SCANNER_NAME, PC_NAME;

// Initialize folder paths
const DEFAULT_PATHS = {
  SCANNED_FOLDER: path.join(process.cwd(), "SCANNED_FOLDER"),
  COMPRESSED_FOLDER: path.join(process.cwd(), "COMPRESSED_FOLDER"),
  READY_TO_UPLOAD_ZIPS: path.join(process.cwd(), "READY_TO_UPLOAD_FOLDER"),
  LINEARIZED_FOLDER: path.join(process.cwd(), "LINEARIZED_FOLDER"),
  UPLOAD_FOLDER: path.join(process.cwd(), "UPLOAD_FOLDER"),
  ERROR_FOLDER: path.join(process.cwd(), "ERROR_FOLDER"),
  SYSTEM_UPLOADED: path.join(process.cwd(), "SYSTEM_UPLOADED"),
  UPLOAD_ERROR: path.join(process.cwd(), "UPLOAD_ERROR"),
};

let SCANNED_FOLDER = DEFAULT_PATHS.SCANNED_FOLDER;
let COMPRESSED_FOLDER = DEFAULT_PATHS.COMPRESSED_FOLDER;
let READY_TO_UPLOAD_ZIPS = DEFAULT_PATHS.READY_TO_UPLOAD_ZIPS;
let LINEARIZED_FOLDER = DEFAULT_PATHS.LINEARIZED_FOLDER;
let UPLOAD_FOLDER = DEFAULT_PATHS.UPLOAD_FOLDER;
let ERROR_FOLDER = DEFAULT_PATHS.ERROR_FOLDER;
let SYSTEM_UPLOADED = DEFAULT_PATHS.SYSTEM_UPLOADED;
let UPLOAD_ERROR = DEFAULT_PATHS.UPLOAD_ERROR;

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

// Check internet connection
async function checkInternetConnection() {
  try {
    await dns.promises.resolve("www.google.com");
    return true;
  } catch {
    return false;
  }
}

// Ask for folders
async function promptForFolders() {
  // Create default folders if they don't exist
  Object.values(DEFAULT_PATHS).forEach((folder) => {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }
  });

  const responses = await inquirer.prompt([
    {
      type: "input",
      name: "scanner",
      message: "🧍 Scanner Name / ID:",
      default: `Scanner-01`,
      validate: (input) => input.trim() !== "" || "Scanner name required",
    },
    {
      type: "input",
      name: "pc",
      message: "💻 PC Name / No:",
      default: os.hostname(),
      validate: (input) => input.trim() !== "" || "PC name required",
    },
    {
      type: "input",
      name: "scanned",
      message: "📥 Enter path for SCANNED_FOLDER:",
      default: DEFAULT_PATHS.SCANNED_FOLDER,
      validate: (input) => (fs.existsSync(input) && fs.lstatSync(input).isDirectory()) || "Invalid folder path",
    },
    {
      type: "input",
      name: "compressed",
      message: "📦 Enter path for COMPRESSED_FOLDER:",
      default: DEFAULT_PATHS.COMPRESSED_FOLDER,
      validate: (input) => (fs.existsSync(input) && fs.lstatSync(input).isDirectory()) || "Invalid folder path",
    },
    {
      type: "input",
      name: "ready",
      message: "🚀 Enter path for READY_TO_UPLOAD_FOLDER:",
      default: DEFAULT_PATHS.READY_TO_UPLOAD_ZIPS,
      validate: (input) => (fs.existsSync(input) && fs.lstatSync(input).isDirectory()) || "Invalid folder path",
    },
    {
      type: "input",
      name: "linearized",
      message: "📄 Enter path for LINEARIZED_FOLDER:",
      default: DEFAULT_PATHS.LINEARIZED_FOLDER,
      validate: (input) => (fs.existsSync(input) && fs.lstatSync(input).isDirectory()) || "Invalid folder path",
    },
  ]);

  SCANNED_FOLDER = responses.scanned;
  COMPRESSED_FOLDER = responses.compressed;
  READY_TO_UPLOAD_ZIPS = responses.ready;
  SCANNER_NAME = responses.scanner;
  PC_NAME = responses.pc;
  LINEARIZED_FOLDER = responses.linearized;

  // Create additional folders if they don't exist
  [UPLOAD_FOLDER, ERROR_FOLDER, SYSTEM_UPLOADED, UPLOAD_ERROR].forEach((folder) => {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }
  });
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
    const gsCmd = `"${gsPackage}" -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/screen -dDownsampleColorImages=true -dColorImageResolution=150 -dNOPAUSE -dQUIET -dBATCH -sOutputFile="${outputPath}" "${inputPath}"`;

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

// Move PDFs to linearized folder
async function moveToDestinationFolder(sourceFolderPath, destinationFolderPath, pdfs) {
  for (const file of pdfs) {
    const sourcePath = path.join(sourceFolderPath, file);
    const destPath = path.join(destinationFolderPath, file);

    // Generate and save report
    await generateAndSaveReport(path.basename(sourcePath), sourcePath);

    try {
      // Move the file
      fs.renameSync(sourcePath, destPath);
      logEvent(`📄 Moved ${file} to ${destinationFolderPath}`);
      logCsvEvent({
        folder: sourcePath,
        file,
        status: "Pass",
        action: `Move to ${destinationFolderPath}`,
        message: `Moved to ${destPath}`,
      });
    } catch (err) {
      logEvent(`❌ Failed to move ${file}: ${err}`);
      logCsvEvent({
        folder: sourcePath,
        file,
        status: "Fail",
        action: `Move to ${destinationFolderPath}`,
        message: err.toString(),
      });
    }
  }
}

// Clean up original folder
function cleanupOriginalFolder(folderPath) {
  try {
    fs.rmdirSync(folderPath);
    logEvent(`🗑️ Removed original folder: ${folderPath}`);
    logCsvEvent({
      folder: folderPath,
      file: "",
      status: "Pass",
      action: "Cleanup",
      message: "Original folder removed",
    });
  } catch (err) {
    logEvent(`⚠️ Failed to remove original folder: ${err}`);
    logCsvEvent({
      folder: folderPath,
      file: "",
      status: "Fail",
      action: "Cleanup",
      message: err.toString(),
    });
  }
}

// Stabilize and prepare folder
async function stabilizeAndPrepareFolder(folderPath) {
  logEvent(`📂 New folder detected: ${folderPath}`);
  logCsvEvent({ folder: folderPath, file: "", status: "Info", action: "Folder Detected", message: folderPath });

  await waitForFolderToStabilize(folderPath, 4000);

  const folderName = path.basename(folderPath);
  const files = fs.readdirSync(folderPath);
  const pdfs = files.filter((f) => f.toLowerCase().endsWith(".pdf"));

  if (pdfs.length === 0) {
    logEvent(`⚠️ No PDFs found in ${folderPath}`);
    logCsvEvent({ folder: folderPath, file: "", status: "Fail", action: "No PDFs", message: "No PDF files found" });
    cleanupOriginalFolder(folderPath);
    return null;
  }

  logEvent(`📄 ${pdfs.length} PDF(s) found in ${folderPath}`);
  logCsvEvent({ folder: folderPath, file: "", status: "Pass", action: "PDFs Found", message: `${pdfs.length} PDFs` });

  return { folderName, pdfs };
}

// Generate PDF report
async function generateAndSaveReport(file, fullPath) {
  logEvent(`📊 Generating report for ${file}...`);
  const pdfReport = await generatePDFReport(fullPath);
  savePDFReport(pdfReport);
  logEvent(`📝 Report generated for ${file}`);
}

// Compress PDF in memory
async function compressPDFInMemory(inputPath) {
  const tempOutputPath = path.join(os.tmpdir(), `compressed_${Date.now()}_${path.basename(inputPath)}`);

  try {
    await compressPDF(inputPath, tempOutputPath);
    const compressedBuffer = fs.readFileSync(tempOutputPath);
    fs.unlinkSync(tempOutputPath); // Clean up temp file
    return compressedBuffer;
  } catch (err) {
    if (fs.existsSync(tempOutputPath)) {
      fs.unlinkSync(tempOutputPath); // Clean up temp file if it exists
    }
    throw err;
  }
}

// Process files in batches
function splitIntoBatches(files, batchSize) {
  const batches = [];
  for (let i = 0; i < files.length; i += batchSize) {
    batches.push(files.slice(i, i + batchSize));
  }
  return batches;
}

// Upload files to system API
async function uploadToSystem(files) {
  try {
    const formData = new FormData();
    const existingFiles = [];

    // First verify which files still exist and can be processed
    for (const filePath of files) {
      if (fs.existsSync(filePath)) {
        existingFiles.push(filePath);
      } else {
        logEvent(`⚠️ File ${path.basename(filePath)} no longer exists in upload folder, skipping`);
        continue;
      }
    }

    if (existingFiles.length === 0) {
      return { success: false, error: "No valid files to process" };
    }

    // Process each existing file
    for (const filePath of existingFiles) {
      try {
        // Double check file still exists before compression
        if (!fs.existsSync(filePath)) {
          logEvent(`⚠️ File ${path.basename(filePath)} was removed during processing, skipping`);
          continue;
        }

        logEvent(`🔄 Compressing ${path.basename(filePath)} before upload`);

        // Get original file size
        const originalStats = fs.statSync(filePath);
        const originalSize = originalStats.size;

        // Compress the PDF
        const compressedBuffer = await compressPDFInMemory(filePath);

        // Compare sizes
        const compressionRatio = (((originalSize - compressedBuffer.length) / originalSize) * 100).toFixed(2);
        logEvent(`📊 Compression achieved: ${compressionRatio}% reduction for ${path.basename(filePath)}`);

        // Create a Blob from the compressed buffer
        formData.append("files", new Blob([compressedBuffer], { type: "application/pdf" }), path.basename(filePath));

        logEvent(`✅ Compressed ${path.basename(filePath)} successfully`);
      } catch (compressionError) {
        logEvent(`⚠️ Compression failed for ${path.basename(filePath)}, using original file: ${compressionError}`);

        // Check if file still exists before trying to read it
        if (!fs.existsSync(filePath)) {
          logEvent(`⚠️ File ${path.basename(filePath)} no longer exists, skipping`);
          continue;
        }

        // If compression fails, use original file
        const fileBuffer = fs.readFileSync(filePath);
        formData.append("files", new Blob([fileBuffer], { type: "application/pdf" }), path.basename(filePath));
      }
    }

    if (formData.entries().next().done) {
      return { success: false, error: "No files were successfully prepared for upload" };
    }

    logEvent(`📤 Uploading batch of ${existingFiles.length} file(s) to system`);
    logCsvEvent({
      folder: UPLOAD_FOLDER,
      file: existingFiles.join(", "),
      status: "Info",
      action: "System Upload Started",
      message: "Initiating upload to system API",
    });

    const response = await fetch("https://devpahsu.paperevaluation.com/api/v1/assessment/answer-code-bulk", {
      method: "POST",
      body: formData,
      headers: {
        // Remove any content-type header to let the browser set it with the boundary
        // 'Content-Type': 'multipart/form-data' // Let browser set this
      },
    });

    if (!response.ok) {
      throw new Error(`Upload failed with status: ${response.status}`);
    }

    const result = await response.json();
    return { success: true, result, processedFiles: existingFiles };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Move files after upload attempt
function moveFilesAfterUpload(files, success) {
  const targetFolder = success ? SYSTEM_UPLOADED : UPLOAD_ERROR;

  files.forEach((filePath) => {
    const fileName = path.basename(filePath);
    const targetPath = path.join(targetFolder, fileName);

    try {
      fs.renameSync(filePath, targetPath);
      logEvent(`${success ? "✅" : "❌"} Moved ${fileName} to ${path.basename(targetFolder)}`);
      logCsvEvent({
        folder: targetFolder,
        file: fileName,
        status: success ? "Pass" : "Fail",
        action: "Move After Upload",
        message: `Moved to ${targetFolder}`,
      });
    } catch (err) {
      logEvent(`❌ Error moving ${fileName}: ${err}`);
      logCsvEvent({
        folder: UPLOAD_FOLDER,
        file: fileName,
        status: "Fail",
        action: "Move After Upload",
        message: err.toString(),
      });
    }
  });
}

// Upload Queue Implementation
class UploadQueue {
  constructor() {
    this.queue = new Set(); // Using Set to prevent duplicates
    this.isProcessing = false;
    this.processedFiles = new Set(); // Track processed files
  }

  // Add files to queue
  enqueue(files) {
    let newFiles = 0;
    for (const file of files) {
      // Only add if not already in queue and not previously processed
      if (!this.queue.has(file) && !this.processedFiles.has(file)) {
        this.queue.add(file);
        newFiles++;
      }
    }
    if (newFiles > 0) {
      logEvent(`📥 Added ${newFiles} new file(s) to upload queue. Queue size: ${this.queue.size}`);
      this.processQueue();
    }
  }

  // Process queue
  async processQueue() {
    if (this.isProcessing || this.queue.size === 0) return;

    try {
      this.isProcessing = true;
      const file = Array.from(this.queue)[0]; // Get first file from Set

      logEvent(`🔄 Processing file from queue: ${path.basename(file)}`);

      const { success, result, error, processedFiles } = await uploadToSystem([file]);

      if (success && processedFiles?.length > 0) {
        logEvent(`✅ Successfully uploaded ${path.basename(file)}`);
        moveFilesAfterUpload(processedFiles, true);
        // Add to processed files set
        processedFiles.forEach((f) => this.processedFiles.add(f));
      } else {
        logEvent(`❌ Failed to upload ${path.basename(file)}: ${error}`);
        if (fs.existsSync(file)) {
          moveFilesAfterUpload([file], false);
        }
        // Still mark as processed to prevent re-processing
        this.processedFiles.add(file);
      }

      // Remove processed file from queue
      this.queue.delete(file);
      logEvent(`📊 Remaining files in queue: ${this.queue.size}`);
    } catch (error) {
      logEvent(`❌ Error processing queue: ${error}`);
    } finally {
      this.isProcessing = false;
      // Process next file if any
      if (this.queue.size > 0) {
        await this.processQueue();
      }
    }
  }

  // Get queue size
  get size() {
    return this.queue.size;
  }

  // Check if file is queued or processed
  isFileHandled(file) {
    return this.queue.has(file) || this.processedFiles.has(file);
  }
}

// Create upload queue instance
const uploadQueue = new UploadQueue();

// Modify processUploadFolder to handle individual files
async function processUploadFolder(newFile = null) {
  let filesToProcess;

  if (newFile) {
    // Process only the new file if specified
    filesToProcess = [newFile];
  } else {
    // Process all PDF files in the folder that haven't been handled yet
    filesToProcess = fs
      .readdirSync(UPLOAD_FOLDER)
      .filter((f) => f.toLowerCase().endsWith(".pdf"))
      .map((f) => path.join(UPLOAD_FOLDER, f))
      .filter((f) => !uploadQueue.isFileHandled(f));
  }

  if (filesToProcess.length === 0) return;

  logEvent(`📄 Found ${filesToProcess.length} new PDF(s) to upload in upload folder`);
  uploadQueue.enqueue(filesToProcess);
}

// Handle new folder in scan folder
async function handleNewFolder(dirPath) {
  try {
    const { folderName, pdfs } = await stabilizeAndPrepareFolder(dirPath);

    if (folderName) {
      logEvent(`✅ Successfully processed folder: ${dirPath}`);
    }

    logEvent(`📄 ${pdfs.length} PDF(s) found in ${dirPath}`);
    logCsvEvent({ folder: dirPath, file: "", status: "Pass", action: "PDFs Found", message: `${pdfs.length} PDFs` });

    await moveToDestinationFolder(dirPath, LINEARIZED_FOLDER, pdfs);

    // Clean up the original folder after moving files
    cleanupOriginalFolder(dirPath);
  } catch (err) {
    logEvent(`❌ Error processing folder ${dirPath}: ${err}`);
    logCsvEvent({
      folder: dirPath,
      file: "",
      status: "Fail",
      action: "Process Folder",
      message: err.toString(),
    });
  }
}

// Handle new PDF file in scan folder
async function handleNewPDF(filePath) {
  try {
    logEvent(`📄 New PDF detected: ${filePath}`);
    logCsvEvent({
      folder: SCANNED_FOLDER,
      file: path.basename(filePath),
      status: "Info",
      action: "PDF Detected",
      message: "New PDF file detected",
    });

    // Wait a bit to ensure file is completely written
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Generate and save report
    await generateAndSaveReport(path.basename(filePath), filePath);

    // Move to linearized folder
    const fileName = path.basename(filePath);
    const linearizedPath = path.join(LINEARIZED_FOLDER, fileName);

    fs.renameSync(filePath, linearizedPath);
    logEvent(`📄 Moved ${fileName} to linearized folder`);
    logCsvEvent({
      folder: SCANNED_FOLDER,
      file: fileName,
      status: "Pass",
      action: "Move to Linearized",
      message: `Moved to ${linearizedPath}`,
    });
  } catch (err) {
    logEvent(`❌ Error processing PDF ${path.basename(filePath)}: ${err}`);
    logCsvEvent({
      folder: SCANNED_FOLDER,
      file: path.basename(filePath),
      status: "Fail",
      action: "Process PDF",
      message: err.toString(),
    });
  }
}

const scanWatcher = () => {
  // Setup all watchers
  const scanWatcher = chokidar.watch(SCANNED_FOLDER, {
    ignoreInitial: false,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold: 10000,
      pollInterval: 500,
    },
    ignored: /(^|[\/\\])\../, // Ignore hidden files
  });

  // Handle new folders
  scanWatcher.on("addDir", (dirPath) => {
    if (dirPath !== SCANNED_FOLDER) {
      handleNewFolder(dirPath);
    }
  });

  // Handle new PDF files
  scanWatcher.on("add", (filePath) => {
    if (path.dirname(filePath) === SCANNED_FOLDER && filePath.toLowerCase().endsWith(".pdf")) {
      handleNewPDF(filePath);
    }
  });

  scanWatcher.on("error", (error) => {
    logEvent(`❌ Watcher error: ${error}`);
    logCsvEvent({ folder: SCANNED_FOLDER, file: "", status: "Fail", action: "Watcher Error", message: error.toString() });
  });

  logEvent(`📡 Watching folder: ${SCANNED_FOLDER}`);
  logCsvEvent({ folder: SCANNED_FOLDER, file: "", status: "Info", action: "Watcher Started", message: "Started watching scanned folder for PDFs and folders" });
};

// Setup watcher for linearized folder
function setupLinearizedWatcher() {
  const OCR_API_URL = process.env.OCR_API_URL || "https://osm-barcode-reader-worker.data-0e9.workers.dev/api/extract";
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000;

  const linearizedWatcher = chokidar.watch(LINEARIZED_FOLDER, {
    ignoreInitial: false,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 500,
    },
  });

  // Helper function to retry API calls
  async function retryOperation(operation, retries = MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
      try {
        return await operation();
      } catch (error) {
        if (i === retries - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY * (i + 1)));
      }
    }
  }

  // Helper function to safely move file
  async function safelyMoveFile(sourcePath, destPath) {
    try {
      await fs.promises.access(sourcePath, fs.constants.F_OK);
      await fs.promises.rename(sourcePath, destPath);
      return true;
    } catch (error) {
      logEvent(`❌ Error moving file ${path.basename(sourcePath)}: ${error.message}`);
      return false;
    }
  }

  linearizedWatcher.on("add", async (filePath) => {
    if (!filePath.toLowerCase().endsWith(".pdf")) return;

    logEvent(`📄 New file detected in linearized folder: ${path.basename(filePath)}`);

    // Check internet connection first
    const isOnline = await checkInternetConnection();
    if (!isOnline) {
      logEvent("⚠️ No internet connection, skipping OCR check...");
      return;
    }

    try {
      const fileName = path.basename(filePath);
      const fileExtension = path.extname(fileName);

      // Read file with error handling
      let fileBuffer;
      try {
        fileBuffer = await fs.promises.readFile(filePath);
      } catch (readError) {
        logEvent(`❌ Error reading file ${fileName}: ${readError.message}`);
        return;
      }

      // Prepare form data for OCR API
      const formData = new FormData();
      formData.append("file", new Blob([fileBuffer], { type: "application/pdf" }), fileName);

      logEvent(`🔍 Performing OCR check on ${fileName}`);

      // Call OCR API with retry mechanism
      const response = await retryOperation(async () => {
        const resp = await fetch(OCR_API_URL, {
          method: "POST",
          body: formData,
          timeout: 30000, // 30 second timeout
        });

        if (!resp.ok) {
          throw new Error(`OCR API returned status ${resp.status}`);
        }

        return resp;
      });

      const result = await response.json();

      if (!result || !result.data) {
        throw new Error("Invalid response from OCR API");
      }

      logEvent(`📋 OCR Result for ${fileName}: ${JSON.stringify(result.data)}`);

      // Check if barcode matches filename
      if (result.data.barcode && result.data.barcode.length > 0 && fileName.replace(fileExtension, "") === result.data.barcode) {
        // Move to upload folder
        const uploadPath = path.join(UPLOAD_FOLDER, fileName);
        if (await safelyMoveFile(filePath, uploadPath)) {
          logEvent(`✅ Barcode matched for ${fileName}, moved to upload folder`);
          logCsvEvent({
            folder: LINEARIZED_FOLDER,
            file: fileName,
            status: "Pass",
            action: "OCR Check & Move",
            message: `Barcode matched: ${result.data.barcode}, moved to upload folder`,
          });
        }
      } else {
        // Move to error folder
        const errorPath = path.join(ERROR_FOLDER, fileName);
        if (await safelyMoveFile(filePath, errorPath)) {
          logEvent(`❌ Barcode mismatch for ${fileName}, moved to error folder`);
          logCsvEvent({
            folder: LINEARIZED_FOLDER,
            file: fileName,
            status: "Fail",
            action: "OCR Check",
            message: `Barcode mismatch or not found. Expected: ${fileName.replace(fileExtension, "")}, Got: ${result.data.barcode || "none"}`,
          });
        }
      }
    } catch (error) {
      logEvent(`❌ Error processing ${path.basename(filePath)}: ${error.message}`);
      logCsvEvent({
        folder: LINEARIZED_FOLDER,
        file: path.basename(filePath),
        status: "Fail",
        action: "Process File",
        message: error.toString(),
      });

      // Move to error folder on processing error
      const errorPath = path.join(ERROR_FOLDER, path.basename(filePath));
      await safelyMoveFile(filePath, errorPath);
      logEvent(`⚠️ Moved ${path.basename(filePath)} to error folder`);
    }
  });

  linearizedWatcher.on("error", (error) => {
    logEvent(`❌ Linearized folder watcher error: ${error}`);
    logCsvEvent({
      folder: LINEARIZED_FOLDER,
      file: "",
      status: "Fail",
      action: "Watcher Error",
      message: error.toString(),
    });
  });

  logEvent(`📡 Watching linearized folder for OCR processing`);
}

// Setup upload folder watcher
function setupUploadWatcher() {
  const UPLOAD_API_URL = process.env.UPLOAD_API_URL || "https://devpahsu.paperevaluation.com/api/v1/assessment/answer-code-bulk";
  const MAX_RETRIES = 3;
  const RETRY_DELAY = 1000;

  // Create necessary folders if they don't exist
  [SYSTEM_UPLOADED, UPLOAD_ERROR].forEach((folder) => {
    if (!fs.existsSync(folder)) {
      fs.mkdirSync(folder, { recursive: true });
    }
  });

  // Helper function to retry API calls
  async function retryOperation(operation, retries = MAX_RETRIES) {
    for (let i = 0; i < retries; i++) {
      try {
        return await operation();
      } catch (error) {
        if (i === retries - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY * (i + 1)));
      }
    }
  }

  // Helper function to safely move file
  async function safelyMoveFile(sourcePath, destPath) {
    try {
      await fs.promises.access(sourcePath, fs.constants.F_OK);
      await fs.promises.rename(sourcePath, destPath);
      return true;
    } catch (error) {
      logEvent(`❌ Error moving file ${path.basename(sourcePath)}: ${error.message}`);
      return false;
    }
  }

  const uploadWatcher = chokidar.watch(UPLOAD_FOLDER, {
    ignoreInitial: false,
    depth: 0,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 500,
    },
  });

  uploadWatcher.on("add", async (filePath) => {
    if (!filePath.toLowerCase().endsWith(".pdf")) return;

    const fileName = path.basename(filePath);
    logEvent(`📄 New file detected in upload folder: ${fileName}`);

    // Check internet connection first
    const isOnline = await checkInternetConnection();
    if (!isOnline) {
      logEvent("⚠️ No internet connection, skipping upload...");
      return;
    }

    try {
      // Read file with error handling
      let fileBuffer;
      try {
        fileBuffer = await fs.promises.readFile(filePath);
      } catch (readError) {
        logEvent(`❌ Error reading file ${fileName}: ${readError.message}`);
        return;
      }

      // Compress the PDF
      let compressedBuffer;
      try {
        logEvent(`🔄 Compressing ${fileName} before upload`);
        compressedBuffer = await compressPDFInMemory(filePath);
        const compressionRatio = (((fileBuffer.length - compressedBuffer.length) / fileBuffer.length) * 100).toFixed(2);
        logEvent(`📊 Compression achieved: ${compressionRatio}% reduction for ${fileName}`);
      } catch (compressionError) {
        logEvent(`⚠️ Compression failed for ${fileName}, using original file: ${compressionError}`);
        compressedBuffer = fileBuffer;
      }

      // Prepare form data
      const formData = new FormData();
      formData.append("files", new Blob([compressedBuffer], { type: "application/pdf" }), fileName);

      logEvent(`📤 Uploading file: ${fileName}`);
      logCsvEvent({
        folder: UPLOAD_FOLDER,
        file: fileName,
        status: "Info",
        action: "Upload Started",
        message: "Initiating upload to system API",
      });

      // Upload with retry mechanism
      const response = await retryOperation(async () => {
        const resp = await fetch(UPLOAD_API_URL, {
          method: "POST",
          body: formData,
          timeout: 30000, // 30 second timeout
        });

        if (!resp.ok) {
          throw new Error(`Upload failed with status: ${resp.status}`);
        }

        return resp;
      });

      const result = await response.json();

      if (!result) {
        throw new Error("Invalid response from upload API");
      }

      // Move to success folder
      const successPath = path.join(SYSTEM_UPLOADED, fileName);
      if (await safelyMoveFile(filePath, successPath)) {
        logEvent(`✅ Successfully uploaded ${fileName}`);
        logCsvEvent({
          folder: UPLOAD_FOLDER,
          file: fileName,
          status: "Pass",
          action: "Upload Complete",
          message: "File uploaded successfully",
        });
      }
    } catch (error) {
      logEvent(`❌ Error processing ${fileName}: ${error.message}`);
      logCsvEvent({
        folder: UPLOAD_FOLDER,
        file: fileName,
        status: "Fail",
        action: "Upload Failed",
        message: error.toString(),
      });

      // Move to error folder
      const errorPath = path.join(UPLOAD_ERROR, fileName);
      if (await safelyMoveFile(filePath, errorPath)) {
        logEvent(`⚠️ Moved ${fileName} to error folder after failed upload`);
      }
    }
  });

  uploadWatcher.on("error", (error) => {
    logEvent(`❌ Upload folder watcher error: ${error}`);
    logCsvEvent({
      folder: UPLOAD_FOLDER,
      file: "",
      status: "Fail",
      action: "Watcher Error",
      message: error.toString(),
    });
  });

  logEvent(`📡 Watching upload folder for system uploads`);
  logCsvEvent({
    folder: UPLOAD_FOLDER,
    file: "",
    status: "Info",
    action: "Upload Watcher Started",
    message: "Started watching upload folder for system uploads",
  });
}

// Main runner
const main = async () => {
  if (!fs.existsSync(CSV_LOG_FILE)) {
    fs.writeFileSync(CSV_LOG_FILE, "Timestamp,Scanner,PC,Folder,File,Status,Action,Message\n");
  }

  // Ask user for folder input
  await promptForFolders();

  // Setup Scan Folder Watcher
  // scanWatcher();

  // // Setup linearized folder watcher (with OCR)
  // setupLinearizedWatcher();

  // // Setup upload folder watcher
  setupUploadWatcher();
};

main();

