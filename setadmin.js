// setadmin.js — jadikan user admin: node setadmin.js <email>
const { initializeApp, cert } = require("firebase-admin");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");

const email = process.argv[2];
if (!email) {
  console.log("pakai: node setadmin.js <email>");
  process.exit(1);
}

initializeApp({ credential: cert(path.join(__dirname, "service-account.json")) });
const db = getFirestore();

(async () => {
  const users = await db.collection("users").get();
  let found = false;
  for (const d of users.docs) {
    const u = d.data();
    if ((u.email || "").toLowerCase() === email.toLowerCase()) {
      await d.ref.update({ role: "admin" });
      console.log(`[setadmin] role admin di-set ke: ${d.id} (${u.email || u.nama || "?"})`);
      found = true;
    }
  }
  if (!found) {
    console.log("[setadmin] email tidak ditemukan. User yang terdaftar:");
    users.docs.forEach((d) => {
      const u = d.data();
      console.log(`  - ${u.email || "(no email)"} | ${u.nama || d.id}`);
    });
  }
  process.exit(0);
})();
