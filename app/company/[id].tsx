import { Feather } from "@expo/vector-icons";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import {
  createGuardEmployee,
  createSupervisorEmployee,
  getApiErrorMessage,
  uploadImageToImageKit,
  useUpdateCompany,
  useCreateEmployee,
  useCompany,
  useListEmployees,
} from "@/api-client";
import type { Company, Employee, EmployeeInput } from "@/api-client";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import {
  Avatar,
  CompanyCardLogo,
  EmptyState,
  ErrorState,
  Field,
  formatMoney,
  GhostButton,
  Header,
  LoadingState,
  PrimaryButton,
  Screen,
  SegmentedControl,
} from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";
import { fonts } from "@/constants/fonts";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useModal } from "@/components/CustomModal";

export default function CompanyScreen() {
  const colors = useColors();
  const router = useRouter();
  const { id, tab: requestedTab } = useLocalSearchParams<{
    id: string;
    tab?: string;
  }>();
  const { user } = useAuth();
  const [selectedMonth, setSelectedMonth] = useState(() => {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  });
  const [tab, setTab] = useState(
    requestedTab === "Employees" ? "Employees" : "Company",
  );
  const [showAdd, setShowAdd] = useState(false);
  const [employeeSearch, setEmployeeSearch] = useState("");
  const company = useCompany(id, selectedMonth.year, selectedMonth.month);
  const employees = useListEmployees(id, undefined, {
    query: { enabled: tab === "Employees" },
  });
  const filteredEmployees = useMemo(() => {
    const query = employeeSearch.trim().toLowerCase();
    if (!query) return employees.data ?? [];
    return (employees.data ?? []).filter((employee) =>
      [
        employee.name,
        employee.contact,
        String(employee.employeeId),
        employee.site,
      ]
        .join(" ")
        .toLowerCase()
        .includes(query),
    );
  }, [employeeSearch, employees.data]);

  if (company.isLoading && !company.data)
    return (
      <Screen>
        <Header title="Company" back />
        <LoadingState label="Loading company..." />
      </Screen>
    );
  if ((company.isError && !company.data) || !company.data)
    return (
      <Screen>
        <Header title="Company" back />
        <ErrorState
          message="Unable to load company details."
          onRetry={() => void company.refetch()}
        />
      </Screen>
    );
  const item = company.data;

  return (
    <Screen scroll={false}>
      <Header title="Company" subtitle={item.name} back />
      <SegmentedControl
        items={["Company", "Employees"]}
        value={tab}
        onChange={setTab}
      />
      {tab === "Company" ? (
        <CompanyOverview
          item={item}
          year={selectedMonth.year}
          month={selectedMonth.month}
          financialsLoading={company.isPlaceholderData}
          onMonthChange={(offset) =>
            setSelectedMonth((current) => shiftMonth(current, offset))
          }
        />
      ) : (
        <View style={{ flex: 1 }}>
          <View style={styles.employeeHeading}>
            <View>
              <Text style={[styles.sectionTitle, { color: colors.foreground }]}>
                Employees
              </Text>
              <Text
                style={[styles.sectionHint, { color: colors.mutedForeground }]}
              >
                {item.employeeCount} active profiles
              </Text>
            </View>
            {user?.role === "ADMIN" || user?.role === "SUPERVISOR" ? (
              <Pressable
                onPress={() => setShowAdd(true)}
                style={[styles.addButton, { backgroundColor: colors.primary }]}
              >
                <Feather
                  name="plus"
                  size={17}
                  color={colors.primaryForeground}
                />
                <Text
                  style={[styles.addText, { color: colors.primaryForeground }]}
                >
                  Add
                </Text>
              </Pressable>
            ) : null}
          </View>
          {user?.role === "ADMIN" || user?.role === "SUPERVISOR" ? (
            <View style={styles.employeeSearchRow}>
              <View
                style={[
                  styles.searchBox,
                  styles.searchBoxInRow,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
              >
                <Feather
                  name="search"
                  size={17}
                  color={colors.mutedForeground}
                />
                <TextInput
                  value={employeeSearch}
                  onChangeText={setEmployeeSearch}
                  placeholder="Search by name, phone or site name"
                  placeholderTextColor={colors.mutedForeground}
                  style={[styles.searchInput, { color: colors.foreground }]}
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="search"
                />
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Refresh employee list"
                accessibilityHint="Fetch the latest employee data"
                onPress={() => void employees.refetch()}
                disabled={employees.isFetching}
                style={({ pressed }) => [
                  styles.refreshButton,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                    opacity: pressed || employees.isFetching ? 0.7 : 1,
                  },
                ]}
              >
                {employees.isFetching ? (
                  <ActivityIndicator size="small" color={colors.primary} />
                ) : (
                  <Feather
                    name="refresh-cw"
                    size={18}
                    color={colors.primary}
                  />
                )}
              </Pressable>
            </View>
          ) : null}
          {employees.isLoading ? (
            <LoadingState label="Loading employees..." />
          ) : employees.isError ? (
            <ErrorState
              message="Unable to load employees."
              onRetry={() => void employees.refetch()}
            />
          ) : (
            <FlatList
              data={filteredEmployees}
              keyExtractor={(employee) => employee.id}
              contentContainerStyle={styles.employeeList}
              renderItem={({ item: employee }) => (
                <EmployeeRow
                  employee={employee}
                  onPress={() =>
                    router.push(`/employee/${employee.employeeId}`)
                  }
                />
              )}
              ListEmptyComponent={
                <EmptyState
                  title={
                    employeeSearch.trim()
                      ? "No matching employees"
                      : "No employees yet"
                  }
                  message={
                    employeeSearch.trim()
                      ? "Try a different name, phone, employee ID, or site."
                      : "Add the first employee to this company."
                  }
                />
              }
              showsVerticalScrollIndicator={false}
              showsHorizontalScrollIndicator={false}
            />
          )}
        </View>
      )}
      <AddEmployeeModal
        companyId={id}
        canChooseRole={user?.role === "ADMIN"}
        visible={showAdd}
        onClose={() => setShowAdd(false)}
        onCreated={() => {
          setShowAdd(false);
          void employees.refetch();
          void company.refetch();
        }}
      />
    </Screen>
  );
}

function shiftMonth(current: { year: number; month: number }, offset: number) {
  const date = new Date(current.year, current.month - 1 + offset, 1);
  return { year: date.getFullYear(), month: date.getMonth() + 1 };
}

function CompanyOverview({
  item,
  year,
  month,
  financialsLoading,
  onMonthChange,
}: {
  item: Company;
  year: number;
  month: number;
  financialsLoading: boolean;
  onMonthChange: (offset: number) => void;
}) {
  const colors = useColors();
  const { user } = useAuth();
  const insets = useSafeAreaInsets();
  const [editing, setEditing] = useState(false);
  const financials = item.financials;

  if (user?.role === "ADMIN" && editing) {
    return (
      <KeyboardAwareScrollViewCompat
        style={{ flex: 1, backgroundColor: colors.background }}
        contentContainerStyle={{
          paddingBottom: insets.bottom + 30,
        }}
        keyboardShouldPersistTaps="handled"
        bottomOffset={30}
        showsVerticalScrollIndicator={false}
      >
        <CompanyEditForm
          item={item}
          onCancel={() => setEditing(false)}
          onSaved={() => setEditing(false)}
        />
      </KeyboardAwareScrollViewCompat>
    );
  }

  return (
    <FlatList
      data={[]}
      renderItem={null}
      ListHeaderComponent={
        <View>
          {user?.role === "ADMIN" || user?.role === "SUPERVISOR" ? (
            <>
              <View
                style={[
                  styles.identityCard,
                  {
                    backgroundColor: colors.card,
                    borderColor: colors.border,
                  },
                ]}
              >
                <CompanyCardLogo name={item.name} uri={item.logoUrl} size={90} />

                <View style={styles.identityCopy}>
                  <Text
                    style={[styles.companyTitle, { color: colors.foreground }]}
                    numberOfLines={2}
                  >
                    {item.name}
                  </Text>
                </View>

               {user?.role === "ADMIN" ?
                <Pressable
                  onPress={() => setEditing(true)}
                  style={({ pressed }) => [
                    styles.compactEditButton,
                    {
                      backgroundColor: "#41D6C320",
                      borderColor: "#41D6C380",
                      borderWidth: 1,
                      opacity: pressed ? 0.82 : 1,
                    },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Edit company details"
                >
                  <Feather
                    name="edit-3"
                    size={14}
                    color={colors.primary}
                  />
                  <Text
                    style={[
                      styles.compactEditButtonText,
                      { color: colors.primary},
                    ]}
                  >
                    Edit Details
                  </Text>
                </Pressable> : null}
              </View>

              <View style={styles.detailsGrid}>
                <Detail label="GST" value={item.gst ?? "—"} />
                <Detail label="Account no." value={item.accountNo ?? "—"} />
                <Detail
                  label="Office number"
                  value={item.officeNumber ?? "—"}
                />
                <Detail
                  label="Total Employees"
                  value={String(item.employeeCount ?? "—")}
                />
              </View>
            </>
          ) : null}

          {user?.role === "ADMIN" && !editing ? (
            <>
              <View
                style={[
                  styles.monthControls,
                  { backgroundColor: colors.card, borderColor: colors.border },
                ]}
              >
                <Pressable
                  onPress={() => onMonthChange(-1)}
                  hitSlop={10}
                  accessibilityLabel="Previous month"
                >
                  <Feather
                    name="chevron-left"
                    size={18}
                    color={colors.foreground}
                  />
                </Pressable>
                <Text style={[styles.monthLabel, { color: colors.foreground }]}>
                  {new Date(year, month - 1, 1).toLocaleString("en-IN", {
                    month: "long",
                    year: "numeric",
                  })}
                </Text>
                <Pressable
                  onPress={() => onMonthChange(1)}
                  hitSlop={10}
                  accessibilityLabel="Next month"
                >
                  <Feather
                    name="chevron-right"
                    size={18}
                    color={colors.foreground}
                  />
                </Pressable>
              </View>
              <View style={styles.financeGrid}>
                {financialsLoading ? (
                  <View
                    style={[
                      styles.financeLoading,
                      { backgroundColor: colors.card, borderColor: colors.border },
                    ]}
                  >
                    <ActivityIndicator size="small" color={colors.primary} />
                    <Text
                      style={[
                        styles.financeLoadingText,
                        { color: colors.mutedForeground },
                      ]}
                    >
                      Loading financial summary…
                    </Text>
                  </View>
                ) : financials
                  ? Object.entries({
                      "Total billing": financials.totalBilling,
                      "Total receiving": financials.totalReceiving,
                      "Cash received": financials.cashReceived,
                      Salary: financials.salary,
                      Balance: financials.balance,
                      Expense: financials.expense,
                      "Dress stock": financials.dressStock,
                      Profit: financials.profit,
                    }).map(([label, value]) => (
                      <View
                        key={label}
                        style={[
                          styles.financeCard,
                          {
                            backgroundColor: colors.card,
                            borderColor: colors.border,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            styles.financeLabel,
                            { color: colors.mutedForeground },
                          ]}
                        >
                          {label}
                        </Text>
                        <Text
                          style={[
                            styles.financeValue,
                            {
                              color:
                                label === "Profit"
                                  ? colors.primary
                                  : colors.foreground,
                            },
                          ]}
                        >
                          {formatMoney(value)}
                        </Text>
                      </View>
                    ))
                  : null}
              </View>
            </>
          ) : null}
        </View>
      }
      showsVerticalScrollIndicator={false}
      showsHorizontalScrollIndicator={false}
    />
  );
}

function CompanyEditForm({
  item,
  onCancel,
  onSaved,
}: {
  item: Company;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const colors = useColors();
  const { showModal } = useModal();
  const queryClient = useQueryClient();
  const update = useUpdateCompany();
  const [gst, setGst] = useState(item.gst ?? "");
  const [officeNumber, setOfficeNumber] = useState(item.officeNumber ?? "");
  const [accountNo, setAccountNo] = useState(item.accountNo ?? "");
  const [logoUri, setLogoUri] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const chooseLogo = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsEditing: true,
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) setLogoUri(result.assets[0].uri);
  };

  const save = async () => {
    try {
      setSaving(true);
      const uploadedLogoUrl = logoUri
        ? await uploadImageToImageKit(logoUri, "logo.png", "image/png", item.id)
        : item.logoUrl;
      const logoUrl =
        logoUri && uploadedLogoUrl
          ? addLogoCacheVersion(uploadedLogoUrl)
          : uploadedLogoUrl;
      const updatedCompany = await update.mutateAsync({
        companyId: item.id,
        data: {
          name: item.name,
          gst: gst.trim() || "—",
          officeNumber: officeNumber.trim() || "—",
          accountNo: accountNo.trim() || "—",
          logoUrl: logoUrl ?? null,
        },
      });
      const latestCompany = {
        ...updatedCompany,
        logoUrl: logoUri ? logoUrl : (updatedCompany.logoUrl ?? logoUrl),
      };
      queryClient.setQueriesData(
        { queryKey: ["/api/companies", item.id] },
        (current: Company | undefined) =>
          current ? { ...current, ...latestCompany } : current,
      );
      queryClient.setQueryData(
        ["/api/companies"],
        (current: Company[] | undefined) =>
          current?.map((company) =>
            company.id === item.id ? { ...company, ...latestCompany } : company,
          ),
      );
      await queryClient.invalidateQueries({ queryKey: ["/api/companies"] });
      showModal({
        type: "success",
        title: "Company updated",
        message: "Company information was saved.",
      });
      onSaved();
    } catch (error) {
      showModal({
        type: "error",
        title: "Unable to save company",
        message: getApiErrorMessage(error, "Please try again."),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <View
      style={[
        styles.companyEditCard,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
    >
      <Pressable
        onPress={onCancel}
        disabled={saving}
        hitSlop={10}
        style={({ pressed }) => [
          styles.closeButton,
          {
            opacity: pressed ? 0.6 : 1,
          },
        ]}
      >
        <Feather name="x" size={22} color={colors.mutedForeground} />
      </Pressable>
      <View style={styles.editFormHeading}>
        <Text style={[styles.editFormTitle, { color: colors.foreground }]}>
          Edit Company Details
        </Text>
      </View>
      <Pressable
        onPress={() => void chooseLogo()}
        disabled={saving}
        style={({ pressed }) => [
          styles.logoPicker,
          {
            backgroundColor: colors.secondary,
            borderColor: colors.border,
            opacity: pressed ? 0.78 : 1,
          },
        ]}
      >
        <Avatar name={item.name} uri={logoUri ?? item.logoUrl} size={82} />
        <View style={styles.logoPickerCopy}>
          <Text style={[styles.logoPickerTitle, { color: colors.foreground }]}>
            {logoUri ? "Logo selected" : "Upload logo"}
          </Text>
          <Text
            style={[styles.logoPickerText, { color: colors.mutedForeground }]}
          >
            Tap to choose a new image
          </Text>
        </View>
        <Feather name="chevron-right" size={18} color={colors.primary} />
      </Pressable>

      <View style={[styles.editFields, { marginTop: 16 }]}>
        <Field
          label="GST / GSTIN"
          value={gst}
          onChangeText={setGst}
          placeholder="Enter GST / GSTIN"
          disabled={saving}
        />
        <Field
          label="Office Number"
          value={officeNumber}
          onChangeText={setOfficeNumber}
          placeholder="Enter office number"
          keyboardType="phone-pad"
          disabled={saving}
        />
        <Field
          label="Account Number"
          value={accountNo}
          onChangeText={setAccountNo}
          placeholder="Enter account number"
          keyboardType="numeric"
          disabled={saving}
        />
      </View>

      <View style={styles.companyEditActions}>
        <PrimaryButton
          label={saving ? "Saving..." : "Save Details"}
          icon="check"
          disabled={saving}
          onPress={() => void save()}
        />
        <GhostButton label="Cancel" onPress={onCancel} disabled={saving} />
      </View>
    </View>
  );
}

function addLogoCacheVersion(url: string) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}v=${Date.now()}`;
}

function Detail({ label, value }: { label: string; value: string }) {
  const colors = useColors();
  return (
    <View style={[styles.detail, { backgroundColor: colors.secondary }]}>
      <Text style={[styles.detailLabel, { color: colors.mutedForeground }]}>
        {label}
      </Text>
      <Text
        numberOfLines={1}
        style={[styles.detailValue, { color: colors.foreground }]}
      >
        {value}
      </Text>
    </View>
  );
}

function EmployeeRow({
  employee,
  onPress,
}: {
  employee: Employee;
  onPress: () => void;
}) {
  const colors = useColors();
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.employeeRow,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          opacity: pressed ? 0.82 : 1,
        },
      ]}
    >
      <Avatar name={employee.name} uri={employee.profilePictureUrl} />
      <View style={{ flex: 1 }}>
        <Text style={[styles.employeeName, { color: colors.foreground }]}>
          {employee.name}
        </Text>
        <Text style={[styles.employeeMeta, { color: colors.mutedForeground }]}>
          EMP-ID: {employee.employeeId} · {employee.site}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <View style={[styles.rolePill, { backgroundColor: colors.secondary }]}>
          <Text style={[styles.roleText, { color: colors.primary }]}>
            {employee.role === "Security Guard" ? "Guard" : "Supervisor"}
          </Text>
        </View>
        <Feather
          name="chevron-right"
          size={17}
          color={colors.mutedForeground}
        />
      </View>
    </Pressable>
  );
}

function AddEmployeeModal({
  companyId,
  canChooseRole,
  visible,
  onClose,
  onCreated,
}: {
  companyId: string;
  canChooseRole: boolean;
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { showModal } = useModal();
  const mutation = useCreateEmployee();
  const [name, setName] = useState("");
  const [contact, setContact] = useState("");
  const [email, setEmail] = useState("");
  const [age, setAge] = useState("");
  const [password, setPassword] = useState("");
  const [site, setSite] = useState("");
  const [basic, setBasic] = useState("24000");
  const [role, setRole] = useState<"Security Guard" | "Supervisor">(
    "Security Guard",
  );
  const [supervisorSubmitting, setSupervisorSubmitting] = useState(false);
  const isSaving = mutation.isPending || supervisorSubmitting;
  const submit = () => {
    if (
      !name.trim() ||
      !contact.trim() ||
      (role === "Supervisor" && password.length < 8)
    )
      return showModal({
        type: "warning",
        title: "Missing details",
        message:
          role === "Security Guard"
            ? "Add a name and phone number."
            : "Add a name, contact, and a password of at least 8 characters.",
      });
    if (!/^\d{10}$/.test(contact)) {
      return showModal({
        type: "warning",
        title: "Invalid phone number",
        message: "Phone number must be exactly 10 digits.",
      });
    }
    if (role === "Security Guard") {
      if (
        !/^\d{10}$/.test(contact) ||
        !age ||
        Number(age) < 18 ||
        password.length < 8
      ) {
        return showModal({
          type: "warning",
          title: "Missing details",
          message:
            "Security Guards need a 10-digit phone number, age 18 or above, and a password of at least 8 characters.",
        });
      }
      createGuardEmployee(companyId, {
        name: name.trim(),
        phoneNumber: contact,
        email: email.trim(),
        age: Number(age),
        password,
        site: site.trim(),
        basicSalary: Number(basic),
      })
        .then(onCreated)
        .catch((error) => {
          showModal({
            type: "error",
            title: "Could not add employee",
            message: getApiErrorMessage(
              error,
              "The account was not saved. Try again.",
            ),
          });
        });
      return;
    }
    if (role === "Supervisor") {
      setSupervisorSubmitting(true);
      createSupervisorEmployee(companyId, {
        name: name.trim(),
        phoneNumber: contact,
        email: email.trim(),
        password,
      })
        .then(onCreated)
        .catch((error) => {
          showModal({
            type: "error",
            title: "Could not add employee",
            message: getApiErrorMessage(
              error,
              "The supervisor account was not saved. Try again.",
            ),
          });
        })
        .finally(() => setSupervisorSubmitting(false));
      return;
    }
    const data: EmployeeInput = {
      name,
      contact,
      email: email.trim() || undefined,
      site,
      role,
      salary: Number(basic),
      basicSalary: Number(basic),
      allowances: 1500,
      overtime: 0,
      pf: 1800,
      esic: 450,
      dateOfJoining: new Date().toISOString().slice(0, 10),
    };
    mutation.mutate(
      { companyId, data },
      {
        onSuccess: onCreated,
        onError: (error) =>
          showModal({
            type: "error",
            title: "Could not add employee",
            message: getApiErrorMessage(
              error,
              "The employee was not saved. Try again.",
            ),
          }),
      },
    );
  };
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <KeyboardAwareScrollViewCompat
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={[
          styles.modalContent,
          {
            paddingTop: insets.top + 28,
            paddingBottom: insets.bottom + 34,
          },
        ]}
        keyboardShouldPersistTaps="handled"
        bottomOffset={30}
      >
        <View style={styles.modalHeader}>
          <View>
            <Text style={[styles.modalTitle, { color: colors.foreground }]}>
              Add employee
            </Text>
            <Text
              style={[styles.sectionHint, { color: colors.mutedForeground }]}
            >
              A unique numeric Employee ID will be generated.
            </Text>
          </View>
          <Pressable onPress={onClose} hitSlop={10}>
            <Feather name="x" size={22} color={colors.mutedForeground} />
          </Pressable>
        </View>
        <Field
          label="Full name"
          value={name}
          onChangeText={setName}
          placeholder="Employee name"
        />
        <Field
          label="Contact"
          value={contact}
          onChangeText={(value) =>
            setContact(value.replace(/\D/g, "").slice(0, 10))
          }
          keyboardType="phone-pad"
          prefix="+91"
          placeholder="Phone number"
        />
        <Field
          label="Email (optional)"
          value={email}
          onChangeText={setEmail}
          placeholder="name@company.com"
        />
        {role === "Security Guard" ? (
          <>
            <Field
              label="Age *"
              value={age}
              onChangeText={(value) =>
                setAge(value.replace(/\D/g, "").slice(0, 3))
              }
              keyboardType="numeric"
              placeholder="18 or above"
            />
            <Field
              label="Password *"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              placeholder="At least 8 characters"
            />
          </>
        ) : (
          <Field
            label="Password *"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            placeholder="At least 8 characters"
          />
        )}
        {role === "Security Guard" ? (
          <>
            <Field
              label="Site"
              value={site}
              onChangeText={setSite}
              placeholder="Assigned site"
            />
            <Field
              label="Basic salary"
              value={basic}
              onChangeText={setBasic}
              keyboardType="numeric"
              placeholder="24000"
            />
          </>
        ) : null}
        {canChooseRole ? (
          <>
            <Text
              style={[styles.fieldLabel, { color: colors.mutedForeground }]}
            >
              ROLE
            </Text>
            <View style={styles.roleOptions}>
              <Pressable
                onPress={() => setRole("Security Guard")}
                style={[
                  styles.roleOption,
                  {
                    borderColor:
                      role === "Security Guard"
                        ? colors.primary
                        : colors.border,
                    backgroundColor:
                      role === "Security Guard"
                        ? colors.secondary
                        : colors.card,
                  },
                ]}
              >
                <Text
                  style={[styles.roleOptionText, { color: colors.foreground }]}
                >
                  Security Guard
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setRole("Supervisor")}
                style={[
                  styles.roleOption,
                  {
                    borderColor:
                      role === "Supervisor" ? colors.primary : colors.border,
                    backgroundColor:
                      role === "Supervisor" ? colors.secondary : colors.card,
                  },
                ]}
              >
                <Text
                  style={[styles.roleOptionText, { color: colors.foreground }]}
                >
                  Supervisor
                </Text>
              </Pressable>
            </View>
          </>
        ) : null}
        <PrimaryButton
          label={isSaving ? "Saving..." : "Save employee"}
          icon="check"
          disabled={isSaving}
          onPress={submit}
        />
        <GhostButton label="Cancel" onPress={onClose} />
      </KeyboardAwareScrollViewCompat>
    </Modal>
  );
}

const styles = StyleSheet.create({
  employeeHeading: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 13,
  },
  closeButton: {
    position: "absolute",
    top: 14,
    right: 14,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
  },
  sectionTitle: { ...fonts.bold, fontSize: 18 },
  sectionHint: { ...fonts.regular, fontSize: 12, marginTop: 4 },
  addButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderRadius: 13,
    paddingHorizontal: 13,
    paddingVertical: 10,
  },
  addText: { ...fonts.bold, fontSize: 12 },
  searchBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    marginBottom: 12,
  },
  employeeSearchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 12,
  },
  searchBoxInRow: {
    flex: 1,
    marginBottom: 0,
  },
  refreshButton: {
    width: 48,
    height: 48,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: 14,
  },
  searchInput: {
    flex: 1,
    minHeight: 44,
    ...fonts.regular,
    fontSize: 13,
  },
  employeeList: { gap: 10, paddingBottom: 24 },
  employeeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderWidth: 1,
    borderRadius: 18,
  },
  employeeName: { ...fonts.bold, fontSize: 14 },
  employeeMeta: { ...fonts.regular, fontSize: 12, marginTop: 4 },
  rowRight: { alignItems: "flex-end", gap: 8 },
  rolePill: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 },
  roleText: { ...fonts.bold, fontSize: 10 },
  identityCard: {
    flexDirection: "row",
    position: "relative",
    alignItems: "center",
    gap: 14,
    padding: 16,
    borderRadius: 20,
    borderWidth: 1,
    marginBottom: 12,
  },
  identityCopy: {
    flex: 1,
    minWidth: 0,
    marginLeft: 14,
  },
  compactEditButton: {
    position: "absolute",
    top: 4,
    right: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 12,
  },
  compactEditButtonText: { ...fonts.bold, fontSize: 11 },
  companyTitle: { ...fonts.bold, fontSize: 17, lineHeight: 22 },
  companyMeta: { ...fonts.regular, fontSize: 12, marginTop: 4 },
  detailsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 9,
    marginBottom: 23,
  },
  detail: { width: "48%", borderRadius: 14, padding: 12 },
  detailLabel: {
    ...fonts.semibold,
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  detailValue: { ...fonts.semibold, fontSize: 13, marginTop: 6 },
  financeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 9 },
  financeLoading: {
    width: "100%",
    minHeight: 120,
    borderWidth: 1,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  financeLoadingText: { ...fonts.medium, fontSize: 13 },
  financeCard: { width: "48%", borderWidth: 1, borderRadius: 16, padding: 13 },
  financeLabel: { ...fonts.medium, fontSize: 11 },
  financeValue: { ...fonts.bold, fontSize: 16, marginTop: 7 },
  monthControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderRadius: 13,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 13,
  },
  monthLabel: { ...fonts.semibold, fontSize: 13 },
  companyEditCard: {
    position: "relative",
    borderWidth: 1,
    borderRadius: 20,
    padding: 16,
    marginBottom: 20,
  },
  editFormHeading: { marginBottom: 18 },
  editFormTitle: { ...fonts.bold, fontSize: 18 },
  editFormHint: { ...fonts.regular, fontSize: 12, marginTop: 5 },
  logoSectionLabel: {
    ...fonts.semibold,
    fontSize: 11,
    letterSpacing: 0.7,
    marginTop: 8,
    marginBottom: 8,
  },
  logoPickerCopy: { flex: 1, gap: 4 },
  logoPickerTitle: { ...fonts.semibold, fontSize: 13 },
  logoPicker: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 76,
    padding: 11,
    borderWidth: 1,
    borderRadius: 15,
  },
  logoPickerText: { ...fonts.regular, fontSize: 11 },
  editFields: { gap: 2 },
  companyEditActions: { gap: 2, marginTop: 16 },
  modalContent: { padding: 20, paddingTop: 28, paddingBottom: 34 },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 24,
  },
  modalTitle: { ...fonts.bold, fontSize: 24 },
  fieldLabel: {
    ...fonts.semibold,
    fontSize: 12,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    marginBottom: 8,
  },
  roleOptions: { flexDirection: "row", gap: 9, marginBottom: 20 },
  roleOption: {
    flex: 1,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: "center",
  },
  roleOptionText: { ...fonts.semibold, fontSize: 12 },
});
