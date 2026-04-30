/**
 * Email Service for LinkManagement.net
 * 
 * Handles all outgoing email notifications using nodemailer + EmailIt SMTP.
 * All sends are fire-and-forget (non-blocking) – a failed email never crashes the API.
 */

const nodemailer = require('nodemailer');

// ─── SMTP Transporter ────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.emailit.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false, // STARTTLS on port 587
    auth: {
        user: process.env.SMTP_USER || 'emailit',
        pass: process.env.SMTP_PASSWORD
    }
});

const FROM = `"LinkManagement" <${process.env.FROM_EMAIL || 'contact@linkmanagement.net'}>`;

// ─── Base HTML wrapper ───────────────────────────────────────────────
const wrapHTML = (bodyContent) => `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { margin:0; padding:0; background:#f4f4f7; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
  .container { max-width:600px; margin:30px auto; background:#ffffff; border-radius:12px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08); }
  .header { background: linear-gradient(135deg, #1e293b 0%, #334155 100%); padding:28px 32px; text-align:center; }
  .header h1 { color:#ffffff; font-size:22px; margin:0; font-weight:600; letter-spacing:0.5px; }
  .header .tagline { color:#94a3b8; font-size:13px; margin-top:4px; }
  .body { padding:32px; color:#334155; line-height:1.7; font-size:15px; }
  .body h2 { color:#1e293b; font-size:20px; margin:0 0 16px 0; }
  .highlight-box { background:#f8fafc; border-left:4px solid #f97316; padding:16px 20px; border-radius:0 8px 8px 0; margin:20px 0; }
  .highlight-box p { margin:4px 0; }
  .highlight-box .label { color:#64748b; font-size:13px; text-transform:uppercase; letter-spacing:0.5px; }
  .highlight-box .value { color:#0f172a; font-size:16px; font-weight:600; }
  .table-wrap { overflow-x:auto; margin:16px 0; }
  table { width:100%; border-collapse:collapse; font-size:14px; }
  table th { background:#f1f5f9; color:#475569; padding:10px 14px; text-align:left; font-weight:600; font-size:12px; text-transform:uppercase; letter-spacing:0.5px; }
  table td { padding:10px 14px; border-bottom:1px solid #e2e8f0; color:#334155; }
  table tr:last-child td { border-bottom:none; }
  .badge { display:inline-block; padding:4px 12px; border-radius:20px; font-size:12px; font-weight:600; }
  .badge-success { background:#dcfce7; color:#166534; }
  .badge-pending { background:#fef3c7; color:#92400e; }
  .badge-info { background:#dbeafe; color:#1e40af; }
  .btn { display:inline-block; padding:12px 28px; background:#f97316; color:#ffffff; text-decoration:none; border-radius:8px; font-weight:600; font-size:15px; margin-top:16px; }
  .btn:hover { background:#ea580c; }
  .footer { background:#f8fafc; padding:20px 32px; text-align:center; border-top:1px solid #e2e8f0; }
  .footer p { color:#94a3b8; font-size:12px; margin:4px 0; }
  .footer a { color:#f97316; text-decoration:none; }
  .amount { font-size:28px; font-weight:700; color:#16a34a; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>LinkManagement.net</h1>
    <div class="tagline">Professional Link Building Platform</div>
  </div>
  <div class="body">
    ${bodyContent}
  </div>
  <div class="footer">
    <p>This is an automated notification from <a href="https://www.linkmanagement.net">LinkManagement.net</a></p>
    <p>&copy; ${new Date().getFullYear()} LinkManagement. All rights reserved.</p>
  </div>
</div>
</body>
</html>`;

// ─── Core send function (fire-and-forget) ────────────────────────────
const sendEmail = async (to, subject, htmlBody) => {
    try {
        const info = await transporter.sendMail({
            from: FROM,
            to,
            subject,
            html: wrapHTML(htmlBody)
        });
        console.log(`📧 Email sent to ${to} – ${subject} (messageId: ${info.messageId})`);
        return true;
    } catch (err) {
        console.error(`❌ Email FAILED to ${to} – ${subject}:`, err.message);
        return false;
    }
};

// ═══════════════════════════════════════════════════════════════════════
// NOTIFICATION TEMPLATES
// ═══════════════════════════════════════════════════════════════════════

/**
 * 1. Site Added Notification
 */
const sendSiteAddedEmail = (bloggerEmail, bloggerName, siteDomain) => {
    const subject = `✅ Your site "${siteDomain}" has been added – LinkManagement`;
    const body = `
    <h2>Hello ${bloggerName || 'Blogger'},</h2>
    <p>Great news! Your website has been successfully added to our platform.</p>
    
    <div class="highlight-box">
      <p class="label">Website Domain</p>
      <p class="value">${siteDomain}</p>
    </div>

    <p>Your site is now in our system and will be considered for upcoming link-building orders once approved. You'll receive a notification when new tasks are assigned to your site.</p>

    <a href="https://www.linkmanagement.net/blogger/sites" class="btn">View My Sites →</a>
    `;
    // Fire-and-forget — don't await
    sendEmail(bloggerEmail, subject, body);
};

/**
 * 2. Order Assigned Notification (grouped per blogger)
 * 
 * @param {string} bloggerEmail
 * @param {string} bloggerName
 * @param {Array} tasks - Array of { root_domain, order_id }
 */
const sendOrderAssignedEmail = (bloggerEmail, bloggerName, tasks) => {
    const count = tasks.length;
    const subject = `📋 New Task${count > 1 ? 's' : ''} Assigned – ${count} site${count > 1 ? 's' : ''} | LinkManagement`;

    const tableRows = tasks.map(t => `
        <tr>
          <td>${t.root_domain || '-'}</td>
          <td>${t.order_id || '-'}</td>
        </tr>`).join('');

    const body = `
    <h2>Hello ${bloggerName || 'Blogger'},</h2>
    <p>You have been assigned <strong>${count} new task${count > 1 ? 's' : ''}</strong>. Please log in to your dashboard to review and start working on ${count > 1 ? 'them' : 'it'}.</p>

    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Website</th><th>Order ID</th></tr>
        </thead>
        <tbody>
          ${tableRows}
        </tbody>
      </table>
    </div>

    <p>Please complete your tasks within the standard turnaround time. If you have any questions, contact your manager.</p>

    <a href="https://www.linkmanagement.net/blogger/tasks" class="btn">View My Tasks →</a>
    `;
    sendEmail(bloggerEmail, subject, body);
};

/**
 * 3. Payment Approved Notification
 */
const sendPaymentApprovedEmail = (bloggerEmail, bloggerName, amount, remarks) => {
    const subject = `💰 Payment of $${parseFloat(amount).toFixed(2)} Approved – LinkManagement`;

    const body = `
    <h2>Hello ${bloggerName || 'Blogger'},</h2>
    <p>Your withdrawal request has been <span class="badge badge-success">Approved</span> and the payment has been processed.</p>
    
    <div class="highlight-box" style="text-align:center; border-left-color:#16a34a;">
      <p class="label">Payment Amount</p>
      <p class="amount">$${parseFloat(amount).toFixed(2)}</p>
    </div>

    ${remarks ? `
    <div class="highlight-box">
      <p class="label">Remarks</p>
      <p class="value">${remarks}</p>
    </div>` : ''}

    <p>The funds will be transferred to your registered payment method. Please allow up to 3-5 business days for the amount to reflect in your account.</p>

    <a href="https://www.linkmanagement.net/blogger/wallet" class="btn">View Wallet →</a>
    `;
    sendEmail(bloggerEmail, subject, body);
};

module.exports = {
    sendEmail,
    sendSiteAddedEmail,
    sendOrderAssignedEmail,
    sendPaymentApprovedEmail
};
