declare namespace Cloudflare {
  interface Env {
    NAIKEN_PUBLIC_EGRESS_URL?: string;
    OPENAI_API_KEY?: string;
    NAIKEN_AGENT_MODEL?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
