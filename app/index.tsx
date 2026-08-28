import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { CompanyLogo, Field, PrimaryButton } from "@/components/ui";
import { useAuth } from "@/context/AuthContext";
import { useColors } from "@/hooks/useColors";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { fonts } from "@/constants/fonts";
import { useModal } from "@/components/CustomModal";

export default function LoginScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { user, isLoading, signIn } = useAuth();
  const { showModal } = useModal();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isLoading && user) {
      router.replace("/home");
    }
  }, [isLoading, router, user]);

  if (isLoading)
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        {/* Login page: shown while the authentication session is loading. */}
        <CompanyLogo size={95} />
      </View>
    );
  if (user)
    return (
      <View style={[styles.loading, { backgroundColor: colors.background }]}>
        {/* Login page: shown briefly while redirecting an authenticated user. */}
        <CompanyLogo size={95} />
      </View>
    );

  const submit = async () => {
    setSubmitting(true);
    try {
      await signIn(identifier, password);
      router.replace("/home");
    } catch (error) {
      const isInvalidCredentials =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 401;
      const message = isInvalidCredentials
        ? "Wrong ID or password. Please try again."
        : error instanceof Error && error.message
          ? error.message
          : "Check your phone/email and password, then try again.";
      showModal({
        type: "error",
        title: isInvalidCredentials ? "Invalid credentials" : "Sign in failed",
        message,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAwareScrollViewCompat
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={[
        styles.container,
        { paddingTop: insets.top + 50, paddingBottom: insets.bottom + 28 },
      ]}
      bottomOffset={45}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.brandRow}>
        <View style={[styles.brandMark, { marginLeft: 10 }]}>
          {/* Login page: primary brand mark above the sign-in form. */}
          <CompanyLogo size={65} />
        </View>
        <Text style={[styles.brandName, { color: colors.foreground }]}>
          TARGET SECURITY
        </Text>
      </View>
      <Text style={[styles.title, { color: colors.foreground }]}>
        Keep every site{`\n`}moving forward.
      </Text>
      <View
        style={[
          styles.formCard,
          { backgroundColor: colors.card, borderColor: colors.border },
        ]}
      >
        <Text style={[styles.formTitle, { color: colors.foreground }]}>
          Welcome back
        </Text>
        <View style={{ height: 18 }} />
        <Field
          label="Email or Phone Number"
          value={identifier}
          onChangeText={setIdentifier}
          keyboardType="default"
          placeholder="Email or phone number"
          disabled={submitting}
        />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="Enter your password"
          disabled={submitting}
        />
        <PrimaryButton
          label={submitting ? "Logging in..." : "Login in"}
          icon="arrow-right"
          disabled={submitting}
          loading={submitting}
          onPress={() => void submit()}
        />
      </View>
      <Pressable
        onPress={() => router.push("/create-account")}
        style={[
          styles.createLink,
          {
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
          },
        ]}
        accessibilityRole="button"
      >
        <Feather
          name={"user-plus"}
          size={17}
          color={colors.primary}
          style={{ marginHorizontal: 10 }}
        />
        <Text style={[styles.createLinkText, { color: colors.primary }]}>
          Create new account
        </Text>
      </Pressable>
    </KeyboardAwareScrollViewCompat>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  container: { flexGrow: 1, paddingHorizontal: 22, justifyContent: "center" },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 11,
    marginBottom: 44,
  },
  brandMark: {
    width: 45,
    height: 45,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  brandName: { ...fonts.bold, fontSize: 16, letterSpacing: 2.4 },
  eyebrow: {
    ...fonts.bold,
    fontSize: 11,
    letterSpacing: 1.6,
    marginBottom: 12,
  },
  title: { ...fonts.bold, fontSize: 34, lineHeight: 39, letterSpacing: -1.1 },
  subtitle: {
    ...fonts.regular,
    fontSize: 15,
    lineHeight: 23,
    marginTop: 16,
    maxWidth: 330,
  },
  formCard: { borderWidth: 1, borderRadius: 24, padding: 20, marginTop: 30 },
  formTitle: { ...fonts.bold, fontSize: 19 },
  formHint: { ...fonts.regular, fontSize: 13, marginTop: 5 },
  demoRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 7,
    marginTop: 18,
  },
  demoText: { ...fonts.regular, fontSize: 11 },
  createLink: { alignItems: "center", marginTop: 18 },
  createLinkText: { ...fonts.semibold, fontSize: 14 },
});
