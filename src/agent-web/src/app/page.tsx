import HealthCopilot from "./health-copilot";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parameters = await searchParams;
  return <HealthCopilot embed={parameters.embed === "1"} />;
}
