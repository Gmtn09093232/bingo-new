const mongoose = require("mongoose");
const mysql = require("mysql2");

const db = mysql.createConnection({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    rejectUnauthorized: false
  }
});

db.connect(err => {
  if (err) {
    console.error("Database connection failed:", err);
  } else {
    console.log("Connected to MySQL ✅");
  }
});

module.exports = db;
mongoose.connect("mongodb+srv://gizie123:0120705@cluster0.xxxxx.mongodb.net/bingo")
.then(() => console.log("✅ MongoDB Atlas Connected"))
.catch(err => console.log(err));