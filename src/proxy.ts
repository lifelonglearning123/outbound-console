import { NextResponse, type NextRequest } from "next/server";

// Send anyone without a session cookie to the sign-in page. This only checks the cookie is present;
// pages and actions verify it properly (and check which clients the user may see).
export function proxy(request: NextRequest) {
  if (!request.cookies.has("oc_session")) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!login|setup|api/cron|_next/static|_next/image|favicon.ico).*)"],
};
