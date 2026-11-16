import { auth } from "@/web/auth/server";

export const runtime = "nodejs";

export function GET(request: Request): Promise<Response> {
  return auth().handler(request);
}

export function POST(request: Request): Promise<Response> {
  return auth().handler(request);
}
