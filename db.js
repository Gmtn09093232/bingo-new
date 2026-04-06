const mongoose = require("mongoose");

const MONGO_URI = "mongodb+srv://giziemelkamu2_db_user:5539yNE2XZGe9veu@cluster17.znizbqj.mongodb.net/?appName=Cluster17";

mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log("MongoDB Connected"))
.catch(err => console.log(err));

module.exports = mongoose;