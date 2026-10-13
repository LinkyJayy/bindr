// Bindr email sender: lets Bindr send its verification and password-reset codes
// from your own Gmail account, for free (Gmail allows about 100 of these a day).
//
// 1. Go to https://script.google.com, click "New project", and replace everything
//    in the editor with this file.
// 2. Change SECRET below to a long random password only you know.
// 3. Choose the "authorize" function at the top and click Run, then allow access.
// 4. Deploy → New deployment → type "Web app". Execute as: Me.
//    Who has access: Anyone. Click Deploy and copy the Web app URL.
// 5. In Railway, set GMAIL_SCRIPT_URL to that URL and GMAIL_SCRIPT_SECRET to the SECRET.

const SECRET = 'change-me-to-a-long-random-password';

function doPost(e) {
  let data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply('bad request');
  }
  if (SECRET.indexOf('change-me') === 0 || data.secret !== SECRET) return reply('wrong secret');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.to))) return reply('bad address');
  MailApp.sendEmail({
    to: data.to,
    subject: String(data.subject).slice(0, 200),
    body: String(data.text),
    htmlBody: String(data.html || ''),
    name: String(data.name || 'Bindr').slice(0, 60),
  });
  return reply('ok');
}

// Run this once from the editor so Google asks for permission to send email.
function authorize() {
  Logger.log('Emails left today: ' + MailApp.getRemainingDailyQuota());
}

function reply(text) {
  return ContentService.createTextOutput(text);
}
