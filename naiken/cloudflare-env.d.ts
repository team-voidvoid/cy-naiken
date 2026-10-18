declare namespace Cloudflare {
  interface Env {
    NAIKEN_PUBLIC_EGRESS_URL?: string;
    OPENAI_API_KEY?: string;
    NAIKEN_AGENT_MODEL?: string;
    NAIKEN_DECISIONS_ENABLED?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
