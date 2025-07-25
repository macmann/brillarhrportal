// leave-system/db.js
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGODB_DB || 'brillarhrportal';

const client = new MongoClient(MONGODB_URI);
let database;

async function init() {
  if (!database) {
    await client.connect();
    database = client.db(DB_NAME);
  }
}

const db = {
  data: null,
  async read() {
    await init();
    const [employees, applications, users] = await Promise.all([
      database.collection('employees').find().toArray(),
      database.collection('applications').find().toArray(),
      database.collection('users').find().toArray()
    ]);
    this.data = { employees, applications, users };
  },
  async write() {
    if (!this.data) return;
    await init();
    const { employees = [], applications = [], users = [] } = this.data;
    await Promise.all([
      database.collection('employees').deleteMany({}),
      database.collection('applications').deleteMany({}),
      database.collection('users').deleteMany({})
    ]);
    if (employees.length) await database.collection('employees').insertMany(employees);
    if (applications.length) await database.collection('applications').insertMany(applications);
    if (users.length) await database.collection('users').insertMany(users);
  }
};

module.exports = { db, init };
