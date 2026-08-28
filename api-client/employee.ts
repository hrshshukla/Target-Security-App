import { useQuery } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

export type EmployeeAadhaar = {
  imageUrl: string;
};

export function useGetEmployeeAadhaar(employeeId: string) {
  return useQuery({
    queryKey: ["employee", employeeId, "aadhaar"],
    queryFn: () =>
      customFetch<EmployeeAadhaar | null>(
        `/api/employees/${employeeId}/documents/aadhaar`,
        { responseType: "json" },
      ),
    enabled: Boolean(employeeId),
  });
}