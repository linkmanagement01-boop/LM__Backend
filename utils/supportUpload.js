/** Chat attachments: images, PDF, DOC/DOCX up to 10 MB, saved in uploads/support-files */
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const dir = path.join(__dirname, '../uploads/support-files');
fs.mkdirSync(dir, { recursive: true });
const ALLOWED = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.doc', '.docx'];

const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, dir),
        filename: (req, file, cb) => cb(null, `sc-${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
    }),
    limits: { fileSize: 10 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        if (ALLOWED.includes(path.extname(file.originalname).toLowerCase())) return cb(null, true);
        const e = new Error('Only images, PDF or DOC files can be sent');
        e.statusCode = 400;
        cb(e);
    }
});

/** Express middleware: one file in field "file", friendly errors */
const supportUpload = (req, res, next) => upload.single('file')(req, res, (err) => {
    if (!err) return next();
    res.status(400).json({ error: 'Validation Error', message: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 10 MB)' : err.message });
});

module.exports = { supportUpload };
