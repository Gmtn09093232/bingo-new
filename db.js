const mongoose = require("mongoose");

mongoose.connect("mongodb+srv://gizie123:0120705@cluster0.xxxxx.mongodb.net/bingo")
.then(() => console.log("✅ MongoDB Atlas Connected"))
.catch(err => console.log(err));