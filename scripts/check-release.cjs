const message = 'Packaging blocked: development safety lock is active. Native Windows/macOS race and Trash restore validation, reuse permission, and trusted signing must be completed and reviewed. See SAFETY-ACCEPTANCE.md.';
function blockPackaging() { throw new Error(message); }
module.exports = blockPackaging;
if (require.main === module) {
  console.error(message);
  process.exitCode = 1;
}
