import Dashboard from "@/components/dashboard";
import { Suspense } from "react";
export default function Home() {
  return (
    <Suspense fallback={<div className="loading">Loading your workspace…</div>}>
      <Dashboard />
    </Suspense>
  );
}
