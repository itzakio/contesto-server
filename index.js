const express = require("express");
const cors = require("cors");
require("dotenv").config();
const app = express();
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

const admin = require("firebase-admin");

const serviceAccount = require("./contesto-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});


// middleware
app.use(express.json());
app.use(cors());

const verifyFBToken = async(req, res, next)=>{
  const authorization = req.headers.authorization;
  if(!authorization){
    return res.status(401).send({message: "unauthorized access"});
  }
  const token = authorization.split(" ")[1];
  if(!token){
     return res.status(401).send({message: "unauthorized access"});
  }
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    console.log("decoded token", decoded);
    req.decodedEmail = decoded.email;
    next();
  } catch (error) {
    return res.status(401).send({ message: "unauthorized access" });
  }
}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.k11w7kv.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

app.get("/", (req, res) => {
  res.send("Contesto!");
});

const run = async () => {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const database = client.db("contesto_db");
    const usersCollection = database.collection("users");
    const creatorsCollection = database.collection("creators");

    // users related apis
    app.get("/users",verifyFBToken, async (req, res)=>{
       const searchText = req.query.searchText;
      const query = {};
      if (searchText) {
        query.$or = [
          { name: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }
      const result = await usersCollection.find(query).toArray();
      res.send(result);
    })
    
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.created_at = new Date().toISOString();
      const email = user.email;
      const userExist = await usersCollection.findOne({ email });
      if (userExist) {
        return res.send({ message: "user already exist" });
      }
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.patch("/users/:id/role", async (req, res)=>{
      const roleInfo = req.body;
      const id = req.params.id;
      const query = {_id: new ObjectId(id)};
      const updatedDoc = {
        $set:{
          role: roleInfo.role,
        }
      };
      const result = await usersCollection.updateOne(query, updatedDoc);
      res.send(result);
    })

    // creator related apis
    app.post("/creators", async(req, res)=>{
      const creatorInfo = req.body;
      creatorInfo.status = "pending"
      creatorInfo.createdAt = new Date().toISOString();
      const creatorExist = await creatorsCollection.findOne({email: creatorInfo.email});
      if(creatorExist){
        return res.send({message: "Creator already exist!"})
      }
      const isAdmin = await usersCollection.findOne({email: creatorInfo.email})
      if(isAdmin.role === "admin"){
        return res.send({message: "Admin can't apply to be a creator!"})
      }
      const result = await creatorsCollection.insertOne(creatorInfo)
      res.send(result)
    })

    

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
};
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Contesto listening on port ${port}`);
});
