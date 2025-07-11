// server.js

const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');
const { db, init, DB_PATH } = require('./db');
const { parse } = require('csv-parse/sync');

const app = express();

// Default admin credentials (can be overridden with env vars)
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@brillar.io';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';


// Utility: Load and Save DB
function loadDB() {
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}
function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

// ---- EMAIL SETUP ----
const mailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === 'true',
  auth: process.env.SMTP_USER ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  } : undefined
});

async function sendEmail(to, subject, text) {
  if (!to || !process.env.SMTP_HOST) return;
  try {
    await mailTransporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text
    });
  } catch (err) {
    console.error('Failed to send email', err);
  }
}

function getEmpEmail(emp) {
  if (!emp) return '';
  const key = Object.keys(emp).find(k => k.toLowerCase() === 'email');
  return emp[key];
}

const SESSION_TOKENS = {}; // token: userId

function genToken() {
  return Math.random().toString(36).slice(2) + Date.now();
}

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- AUTH ----
function authRequired(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token || !SESSION_TOKENS[token]) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.userId = SESSION_TOKENS[token];
  next();
}

init().then(() => {
  // ========== LOGIN ==========
  app.post('/login', async (req, res) => {
    await db.read();
    const { email, password } = req.body;
    const user = db.data.users?.find(u => u.email === email && u.password === password);

    let userObj;
    if (user) {
      userObj = {
        id: user.id,
        email: user.email,
        role: user.role,
        employeeId: user.employeeId
      };
    } else if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
      userObj = {
        id: 'admin',
        email: ADMIN_EMAIL,
        role: 'manager',
        employeeId: null
      };
    } else {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = genToken();
    SESSION_TOKENS[token] = userObj.id;
    res.json({ token, user: userObj });
  });

  // ========== CHANGE PASSWORD ==========
  app.post('/change-password', authRequired, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Missing fields' });
    }
    await db.read();
    const user = db.data.users?.find(u => u.id === req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.password !== currentPassword) {
      return res.status(400).json({ error: 'Current password incorrect' });
    }
    user.password = newPassword;
    await db.write();
    res.json({ success: true });
  });

  // ========== EMPLOYEES ==========
  app.get('/employees', async (req, res) => {
    await db.read();
    res.json(db.data.employees);
  });

  app.post('/employees', async (req, res) => {
    await db.read();
    const id = Date.now();
    const payload = req.body;
    db.data.employees.push({ id, ...payload });
    const emailKey = Object.keys(payload).find(k => k.toLowerCase() === 'email');
    const roleKey = Object.keys(payload).find(k => k.toLowerCase() === 'role');
    const email = emailKey ? payload[emailKey] : undefined;
    if (email) {
      const role = payload[roleKey]?.toLowerCase() === 'manager' ? 'manager' : 'employee';
      db.data.users.push({
        id,
        email,
        password: 'brillar',
        role,
        employeeId: id
      });
    }
    await db.write();
    res.status(201).json({ id, ...payload });
  });

  // ---- BULK CSV UPLOAD ----
  app.post('/employees/bulk', express.text({ type: '*/*' }), async (req, res) => {
    await db.read();
    try {
      const rows = parse(req.body, { columns: true, skip_empty_lines: true });
      const start = Date.now();
      rows.forEach((row, idx) => {
        const id = start + idx;
        const nameKey = Object.keys(row).find(k => k.toLowerCase() === 'name');
        const statusKey = Object.keys(row).find(k => k.toLowerCase() === 'status');
        const annualKey = Object.keys(row).find(k => k.toLowerCase().includes('annual'));
        const casualKey = Object.keys(row).find(k => k.toLowerCase().includes('casual'));
        const medicalKey = Object.keys(row).find(k => k.toLowerCase().includes('medical'));
        const emailKey = Object.keys(row).find(k => k.toLowerCase() === 'email');
        const roleKey = Object.keys(row).find(k => k.toLowerCase() === 'role');
        const emp = {
          id,
          name: row[nameKey] || '',
          status: row[statusKey]?.toLowerCase() === 'inactive' ? 'inactive' : 'active',
          leaveBalances: {
            annual: Number(row[annualKey] ?? 10),
            casual: Number(row[casualKey] ?? 5),
            medical: Number(row[medicalKey] ?? 14)
          },
          ...row
        };
        db.data.employees.push(emp);
        const email = emailKey ? row[emailKey] : undefined;
        if (email) {
          const role = row[roleKey]?.toLowerCase() === 'manager' ? 'manager' : 'employee';
          db.data.users.push({
            id,
            email,
            password: 'brillar',
            role,
            employeeId: id
          });
        }
      });
      await db.write();
      res.status(201).json({ added: rows.length });
    } catch (err) {
      console.error('CSV parse failed', err);
      res.status(400).json({ error: 'Invalid CSV' });
    }
  });

  app.put('/employees/:id', async (req, res) => {
    await db.read();
    const emp = db.data.employees.find(e => e.id == req.params.id);
    if (!emp) return res.status(404).json({ error: 'Not found' });
    Object.assign(emp, req.body);
    await db.write();
    res.json(emp);
  });

  app.patch('/employees/:id/status', async (req, res) => {
    await db.read();
    const emp = db.data.employees.find(e => e.id == req.params.id);
    if (!emp) return res.status(404).json({ error: 'Not found' });
    emp.status = req.body.status;
    await db.write();
    res.json(emp);
  });

  app.delete('/employees/:id', async (req, res) => {
    await db.read();
    const idx = db.data.employees.findIndex(e => e.id == req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Not found' });
    db.data.employees.splice(idx, 1);
    await db.write();
    res.status(204).end();
  });

  // ========== APPLICATIONS ==========
  app.get('/applications', async (req, res) => {
    await db.read();
    let apps = db.data.applications || [];
    if (req.query.employeeId) {
      apps = apps.filter(a => a.employeeId == req.query.employeeId);
    }
    if (req.query.status) {
      apps = apps.filter(a => a.status === req.query.status);
    }
    res.json(apps);
  });

  // ========== LEAVE LOGIC ==========

  // Helper: Get leave days (with half day support)
  function getLeaveDays(app) {
    if (app.halfDay) return 0.5;
    return (
      (new Date(app.to) - new Date(app.from)) / (1000 * 60 * 60 * 24) + 1
    );
  }

  // ---- APPLY FOR LEAVE ----
  app.post('/applications', async (req, res) => {
    await db.read();
    const { employeeId, type, from, to, reason, halfDay, halfDayType } = req.body;
    const id = Date.now();
    const newApp = {
      id,
      employeeId,
      type,
      from,
      to,
      reason,
      status: 'pending',
      ...(halfDay ? { halfDay: true, halfDayType } : {})
    };

    // Deduct balance immediately (pending means leave already deducted)
    const emp = db.data.employees.find(e => e.id == employeeId);
    if (emp && emp.leaveBalances[type] !== undefined) {
      let bal = Number(emp.leaveBalances[type]) || 0;
      let days = halfDay ? 0.5 : ((new Date(to) - new Date(from)) / (1000 * 60 * 60 * 24) + 1);
      if (bal < days) {
        return res.status(400).json({ error: 'Insufficient leave balance.' });
      }
      emp.leaveBalances[type] = bal - days;
    }

    db.data.applications.push(newApp);
    await db.write();

    // Notify managers of new application
    const managers = (db.data.users || []).filter(u => u.role === 'manager');
    const managerEmails = managers.map(m => m.email).filter(Boolean);
    const empEmail = getEmpEmail(emp);
    const name = emp?.name || empEmail || `Employee ${employeeId}`;
    if (managerEmails.length) {
      await sendEmail(
        managerEmails.join(','),
        `Leave request from ${name}`,
        `${name} applied for ${type} leave from ${from} to ${to}.`
      );
    }

    res.status(201).json(newApp);
  });

  // ---- APPROVE LEAVE ----
  app.patch('/applications/:id/approve', async (req, res) => {
    const { id } = req.params;
    const { approver, remark } = req.body;
    const dbObj = loadDB();
    const appIdx = dbObj.applications.findIndex(x => x.id == id);
    if (appIdx < 0) return res.status(404).json({ error: 'Not found' });
    if (dbObj.applications[appIdx].status !== 'pending')
      return res.status(400).json({ error: 'Already actioned' });

    dbObj.applications[appIdx].status = 'approved';
    dbObj.applications[appIdx].approvedBy = approver || '';
    dbObj.applications[appIdx].approverRemark = remark || '';
    dbObj.applications[appIdx].approvedAt = new Date().toISOString();
    saveDB(dbObj);

    const emp = dbObj.employees.find(e => e.id == dbObj.applications[appIdx].employeeId);
    const email = getEmpEmail(emp);
    const name = emp?.name || email || `Employee ${dbObj.applications[appIdx].employeeId}`;
    if (email) {
      await sendEmail(
        email,
        'Leave approved',
        `${name}, your leave from ${dbObj.applications[appIdx].from} to ${dbObj.applications[appIdx].to} has been approved.`
      );
    }

    res.json(dbObj.applications[appIdx]);
  });

  // ---- REJECT LEAVE ----
  app.patch('/applications/:id/reject', async (req, res) => {
    const { id } = req.params;
    const { approver, remark } = req.body;
    const dbObj = loadDB();
    const appIdx = dbObj.applications.findIndex(x => x.id == id);
    if (appIdx < 0) return res.status(404).json({ error: 'Not found' });

    const app = dbObj.applications[appIdx];
    if (app.status !== 'pending' && app.status !== 'approved')
      return res.status(400).json({ error: 'Already actioned' });

    // Credit back balance when rejecting (whether pending or already approved)
    const empIdx = dbObj.employees.findIndex(x => x.id == app.employeeId);
    if (empIdx >= 0) {
      let days = app.halfDay ? 0.5 : ((new Date(app.to) - new Date(app.from)) / (1000 * 60 * 60 * 24) + 1);
      dbObj.employees[empIdx].leaveBalances[app.type] =
        Number(dbObj.employees[empIdx].leaveBalances[app.type]) + days;
    }

    dbObj.applications[appIdx].status = 'rejected';
    dbObj.applications[appIdx].approvedBy = approver || '';
    dbObj.applications[appIdx].approverRemark = remark || '';
    dbObj.applications[appIdx].approvedAt = new Date().toISOString();
    saveDB(dbObj);

    const emp = dbObj.employees.find(e => e.id == app.employeeId);
    const email = getEmpEmail(emp);
    const name = emp?.name || email || `Employee ${app.employeeId}`;
    if (email) {
      await sendEmail(
        email,
        'Leave rejected',
        `${name}, your leave from ${app.from} to ${app.to} has been rejected.`
      );
    }

    res.json(dbObj.applications[appIdx]);
  });

  // ---- CANCEL LEAVE ----
  app.patch('/applications/:id/cancel', async (req, res) => {
    const { id } = req.params;
    const dbObj = loadDB();
    const appIdx = dbObj.applications.findIndex(x => x.id == id);
    if (appIdx < 0) return res.status(404).json({ error: 'Not found' });

    const appObjApp = dbObj.applications[appIdx];
    if (['cancelled', 'rejected'].includes(appObjApp.status)) {
      return res.status(400).json({ error: 'Already cancelled/rejected' });
    }

    // Only allow cancel if today is before leave "from" date
    const now = new Date();
    if (new Date(appObjApp.from) <= now) {
      return res.status(400).json({ error: 'Cannot cancel after leave started' });
    }

    // Credit back balance when cancelling (whether pending or approved)
    const empIdx = dbObj.employees.findIndex(x => x.id == appObjApp.employeeId);
    if (empIdx >= 0) {
      let days = appObjApp.halfDay ? 0.5 : ((new Date(appObjApp.to) - new Date(appObjApp.from)) / (1000 * 60 * 60 * 24) + 1);
      dbObj.employees[empIdx].leaveBalances[appObjApp.type] =
        Number(dbObj.employees[empIdx].leaveBalances[appObjApp.type]) + days;
    }

    dbObj.applications[appIdx].status = 'cancelled';
    dbObj.applications[appIdx].cancelledAt = new Date().toISOString();
    saveDB(dbObj);

    const emp = dbObj.employees.find(e => e.id == appObjApp.employeeId);
    const email = getEmpEmail(emp);
    const name = emp?.name || email || `Employee ${appObjApp.employeeId}`;
    if (email) {
      await sendEmail(
        email,
        'Leave cancelled',
        `${name}, your leave from ${appObjApp.from} to ${appObjApp.to} has been cancelled.`
      );
    }

    res.json(dbObj.applications[appIdx]);
  });

  // (Legacy/optional: PATCH by status field)
  app.patch('/applications/:id/decision', async (req, res) => {
    await db.read();
    const { status } = req.body; // "approved" or "rejected"
    const appIdx = db.data.applications.findIndex(a => a.id == req.params.id);
    const app = db.data.applications[appIdx];
    if (!app) return res.status(404).json({ error: 'Not found' });
    if (status === 'rejected') {
      // Credit back leave
      const emp = db.data.employees.find(e => e.id == app.employeeId);
      if (emp && emp.leaveBalances[app.type] !== undefined) {
        let days = app.halfDay ? 0.5 : ((new Date(app.to) - new Date(app.from)) / (1000 * 60 * 60 * 24) + 1);
        emp.leaveBalances[app.type] = (+emp.leaveBalances[app.type] || 0) + days;
      }
    }
    app.status = status;
    await db.write();
    res.json(app);
  });

  // ========== GLOBAL ERROR HANDLER ==========
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: err.message || 'Server error' });
  });

  // ========== START SERVER ==========
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
