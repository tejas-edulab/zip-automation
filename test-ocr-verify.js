// Quick test for OCR verification logic
// Run: node test-ocr-verify.js

function extractSeatNumberFromBarcode(barcodeSeatNumber) {
  if (!barcodeSeatNumber) return null;
  const parts = barcodeSeatNumber.split("-");
  if (parts.length === 3) return parts[2];
  if (parts.length === 5) return parts[3];
  return null;
}

function verify(fileName, apiResponse) {
  const fileExtension = fileName.slice(fileName.lastIndexOf("."));
  const fileNameWithoutExt = fileName.replace(fileExtension, "");
  const { barcode, barcodeSeatNumber, seatNumber } = apiResponse.data;

  const barcodeMatches = barcode && fileNameWithoutExt === barcode;
  const derivedSeatNumber = extractSeatNumberFromBarcode(barcodeSeatNumber);
  const seatNumberMatches = derivedSeatNumber && derivedSeatNumber === seatNumber;

  const pass = barcodeMatches && seatNumberMatches;
  const reason = !barcodeMatches
    ? `Barcode mismatch — expected: ${fileNameWithoutExt}, got: ${barcode || "none"}`
    : `SeatNumber mismatch — derived: ${derivedSeatNumber || "none"} (from ${barcodeSeatNumber}), got: ${seatNumber || "none"}`;

  return { pass, reason, derivedSeatNumber };
}

const tests = [
  {
    label: "Example 1 — normal format, should PASS",
    fileName: "21247.pdf",
    response: { status: "success", data: { barcodeSeatNumber: "JE-254-170837", barcode: "21247", seatNumber: "170837" }, error: null },
    expect: true,
  },
  {
    label: "Example 2 — two-section format, should PASS",
    fileName: "172208.pdf",
    response: { status: "success", data: { barcodeSeatNumber: "JE-05-I-194116-I", barcode: "172208", seatNumber: "194116" }, error: null },
    expect: true,
  },
  {
    label: "Wrong barcode (filename mismatch), should FAIL",
    fileName: "99999.pdf",
    response: { status: "success", data: { barcodeSeatNumber: "JE-254-170837", barcode: "21247", seatNumber: "170837" }, error: null },
    expect: false,
  },
  {
    label: "Wrong seatNumber (student wrote wrong seat), should FAIL",
    fileName: "21247.pdf",
    response: { status: "success", data: { barcodeSeatNumber: "JE-254-170837", barcode: "21247", seatNumber: "999999" }, error: null },
    expect: false,
  },
  {
    label: "Two-section: seatNumber mismatch, should FAIL",
    fileName: "172208.pdf",
    response: { status: "success", data: { barcodeSeatNumber: "JE-05-I-194116-I", barcode: "172208", seatNumber: "000000" }, error: null },
    expect: false,
  },
];

let passed = 0;
let failed = 0;

for (const t of tests) {
  const result = verify(t.fileName, t.response);
  const ok = result.pass === t.expect;
  console.log(`${ok ? "✅" : "❌"} ${t.label}`);
  if (!ok) {
    console.log(`   Expected pass=${t.expect}, got pass=${result.pass}`);
  }
  if (!result.pass) {
    console.log(`   Reason: ${result.reason}`);
  }
  ok ? passed++ : failed++;
}

console.log(`\n${passed}/${passed + failed} tests passed`);
