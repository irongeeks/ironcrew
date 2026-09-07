import { z } from "zod";
/** Derived from official OpenAPI 2.0.0 fetched 2026-09-07. Account software version still requires a live check. */
const numericId = z.number().int().positive();
const date = z.string().regex(/^\d{2}\.\d{2}\.\d{4}$/);
const decimal = z.string().regex(/^\d{1,10}(?:\.\d{1,2})?$/);
const position = z
  .object({
    accountDatevId: numericId.optional(),
    accountingTypeId: numericId.optional(),
    taxRate: z.number().min(0).max(100),
    net: z.boolean(),
    amount: decimal,
    comment: z.string().max(2000).optional(),
  })
  .strict()
  .refine((value) => Boolean(value.accountDatevId || value.accountingTypeId), "Booking account is required");
export const sevdeskVoucherStageSchema = z
  .object({
    filename: z
      .string()
      .min(1)
      .max(300)
      .regex(/^[A-Za-z0-9._-]+$/),
    voucherDate: date,
    supplierId: numericId.optional(),
    supplierName: z.string().min(1).max(300).optional(),
    description: z.string().min(1).max(300),
    creditDebit: z.enum(["C", "D"]),
    currency: z.string().regex(/^[A-Z]{3}$/),
    taxRuleId: z.enum(["1", "2", "3", "4", "5", "11"]).optional(),
    taxType: z.enum(["default", "eu", "noteu", "custom", "ss"]).optional(),
    taxSetId: numericId.optional(),
    paymentDeadline: date.optional(),
    exchangeRate: z.number().positive().optional(),
    positions: z.array(position).min(1).max(100),
  })
  .strict()
  .refine((value) => Boolean(value.supplierId || value.supplierName), "Supplier is required")
  .refine((value) => Boolean(value.taxRuleId || value.taxType), "Tax rule or account-version tax type is required")
  .refine((value) => value.taxType !== "custom" || Boolean(value.taxSetId), "Custom tax requires configured tax set")
  .refine(
    (value) => value.positions.every((position) => position.net === value.positions[0].net),
    "All positions must consistently use net or gross",
  );
export const sevdeskVoucherBookSchema = z
  .object({
    voucherId: numericId,
    amount: decimal,
    date: z.iso.datetime({ offset: true }),
    type: z.enum(["FULL_PAYMENT", "N"]),
    checkAccountId: numericId,
    checkAccountTransactionId: numericId,
  })
  .strict();
export function voucherPayload(value: z.infer<typeof sevdeskVoucherStageSchema>) {
  return {
    voucher: {
      objectName: "Voucher",
      mapAll: true,
      voucherDate: value.voucherDate,
      supplier: value.supplierId ? { id: value.supplierId, objectName: "Contact" } : null,
      ...(value.supplierName ? { supplierName: value.supplierName } : {}),
      description: value.description,
      status: 50,
      creditDebit: value.creditDebit,
      voucherType: "VOU",
      currency: value.currency,
      ...(value.taxRuleId ? { taxRule: { id: value.taxRuleId, objectName: "TaxRule" } } : {}),
      ...(value.taxType ? { taxType: value.taxType } : {}),
      ...(value.taxSetId ? { taxSet: { id: value.taxSetId, objectName: "TaxSet" } } : {}),
      ...(value.paymentDeadline ? { paymentDeadline: value.paymentDeadline } : {}),
      ...(value.exchangeRate ? { propertyExchangeRate: value.exchangeRate } : {}),
    },
    voucherPosSave: value.positions.map((position) => ({
      objectName: "VoucherPos",
      mapAll: true,
      ...(position.accountDatevId ? { accountDatev: { id: position.accountDatevId, objectName: "AccountDatev" } } : {}),
      ...(position.accountingTypeId
        ? { accountingType: { id: position.accountingTypeId, objectName: "AccountingType" } }
        : {}),
      taxRate: position.taxRate,
      net: position.net,
      ...(position.net ? { sumNet: Number(position.amount) } : { sumGross: Number(position.amount) }),
      ...(position.comment ? { comment: position.comment } : {}),
    })),
    voucherPosDelete: null,
    filename: value.filename,
  };
}
