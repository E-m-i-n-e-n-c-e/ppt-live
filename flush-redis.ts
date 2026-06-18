import Redis from "ioredis";

async function flush() {
  const url = "rediss://default:gQAAAAAAAfdCAAIgcDE0ODA2NjNlN2U3YWQ0Mjc5YWQwNDgxNjdjMzIxZTI1Ng@smiling-panda-128834.upstash.io:6379";
  const redis = new Redis(url);
  
  console.log("Connecting to Redis...");
  await redis.flushall();
  console.log("Successfully cleared all data (FLUSHALL).");
  
  process.exit(0);
}

flush().catch(err => {
  console.error("Failed:", err);
  process.exit(1);
});

// npx tsx flush-redis.ts to run the script
