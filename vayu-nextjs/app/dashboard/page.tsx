import type { Metadata } from "next";

import Dashboard from "./Dashboard";
import "./dashboard.css";

export const metadata: Metadata = {
  title: "VAYU · System Reasoning",
  description: "Live Find → Reason → Patch → Verify dashboard for the AIKavach VAYU cyber reasoning system.",
};

export default function DashboardPage() {
  return <Dashboard />;
}
