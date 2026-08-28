import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Company } from "./generated/api.schemas";
import { customFetch } from "./custom-fetch";

export function useCompany(companyId: string, year: number, month: number) {
  return useQuery({
    queryKey: ["/api/companies", companyId, year, month],
    queryFn: () =>
      customFetch<Company>(
        `/api/companies/${companyId}?year=${year}&month=${month}`,
        { responseType: "json" },
      ),
    enabled: Boolean(companyId),
    // Month navigation should retain the company details while only the
    // financial summary for the requested month is refreshed.
    placeholderData: keepPreviousData,
  });
}
