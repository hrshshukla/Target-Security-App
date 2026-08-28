import { useMutation } from "@tanstack/react-query";
import type { AccountSheetRow } from "./generated/api.schemas";
import { customFetch } from "./custom-fetch";

export function useUpdateAccountSheetRow() {
  return useMutation({
    mutationFn: ({
      year,
      month,
      row,
    }: {
      year: number;
      month: number;
      row: AccountSheetRow;
    }) =>
      customFetch<{ success: boolean }>(
        `/api/account-sheet/${year}/${month}/${row.companyId}`,
        {
          method: "PUT",
          body: JSON.stringify({
            companyId: row.companyId,
            totalBilling: row.totalBilling,
            totalReceiving: row.totalReceiving,
            cashReceived: row.cashReceived,
            salary: row.salary,
            expense: row.expense,
            dressStock: row.dressStock,
          }),
          responseType: "json",
        },
      ),
  });
}