import * as ImagePicker from "expo-image-picker";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ActivityIndicator, Image, StyleSheet, Text, View } from "react-native";
import { getApiErrorMessage, getDocuments, saveAadhaar, updatePassword, updateProfile, uploadImageToImageKit, type UserDocument } from "@/api-client";
import { useAuth } from "@/context/AuthContext";
import { Avatar, Field, LoadingState, PrimaryButton } from "@/components/ui";
import { useColors } from "@/hooks/useColors";
import { fonts } from "@/constants/fonts";
import { useModal } from "@/components/CustomModal";

function cacheBustedImageUrl(url: string | null | undefined, version: number) {
  if (!url) return url;
  return `${url}${url.includes("?") ? "&" : "?"}v=${version}`;
}

export function ProfileForm() {
  const colors = useColors();
  const { user, updateUser } = useAuth();
  const { showModal } = useModal();
  const queryClient = useQueryClient();
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [mobileNumber, setMobileNumber] = useState(normalizeMobileNumber(user?.mobileNumber ?? ""));
  const [profilePictureUrl, setProfilePictureUrl] = useState(user?.profilePictureUrl ?? "");
  const [profilePictureVersion, setProfilePictureVersion] = useState(Date.now());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    setName(user.name);
    setEmail(user.email ?? "");
    setMobileNumber(normalizeMobileNumber(user.mobileNumber ?? ""));
    setProfilePictureUrl(user.profilePictureUrl ?? "");
      setProfilePictureVersion(Date.now());
  }, [user]);

  const chooseImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, quality: 0.8 });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    try {
      setSaving(true);
      const url = await uploadImageToImageKit(asset.uri, "profile-picture.jpg", asset.mimeType ?? "image/jpeg");
      setProfilePictureUrl(url);
      const next = await updateProfile({
        name,
        email,
        mobileNumber: mobileNumber || null,
        profilePictureUrl: url,
      });
      updateUser(next);
      setProfilePictureVersion(Date.now());
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["guard", "me"] }),
        queryClient.refetchQueries({ queryKey: ["/api/auth/me"] }),
        queryClient.refetchQueries({ queryKey: ["/api/companies"] }),
        queryClient.refetchQueries({ queryKey: ["/api/employees"] }),
      ]);
      showModal({ type: "success", title: "Uploaded", message: "Your profile picture was saved." });
    } catch (error) {
      showModal({ type: "error", title: "Upload failed", message: error instanceof Error ? error.message : "Unable to upload image." });
    } finally { setSaving(false); }
  };

  const saveProfile = async () => {
    try {
      setSaving(true);
      const next = await updateProfile({
        name: name.trim(),
        email: email.trim(),
        mobileNumber: mobileNumber || null,
        profilePictureUrl: profilePictureUrl || null,
      });
      setName(next.name);
      setEmail(next.email ?? "");
      setMobileNumber(normalizeMobileNumber(next.mobileNumber ?? ""));
      setProfilePictureUrl(next.profilePictureUrl ?? "");
      updateUser(next);
      setProfilePictureVersion(Date.now());
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ["guard", "me"] }),
        queryClient.refetchQueries({ queryKey: ["/api/auth/me"] }),
        queryClient.refetchQueries({ queryKey: ["/api/companies"] }),
        queryClient.refetchQueries({ queryKey: ["/api/employees"] }),
      ]);
      showModal({ type: "success", title: "Saved", message: "Your profile was updated." });
    } catch (error) {
      showModal({ type: "error", title: "Unable to save", message: getApiErrorMessage(error, "Please try again.") });
    } finally { setSaving(false); }
  };

  return (
    <>
      <View style={styles.profileRow}>
        <Avatar
          name={user?.name ?? name}
          uri={cacheBustedImageUrl(profilePictureUrl || user?.profilePictureUrl, profilePictureVersion)}
          loading={saving}
          size={120}
        />
        <PrimaryButton label="Upload profile picture" onPress={() => void chooseImage()} disabled={saving} loading={saving} />
      </View>
      <Field label="Name" value={name} placeholder="Arav Mehta" onChangeText={setName} />
      <Field label="Email" value={email} placeholder="yourname@email.com" onChangeText={setEmail} />
      <Field
        label="Mobile number"
        value={mobileNumber}
        onChangeText={(value) => setMobileNumber(value.replace(/\D/g, "").slice(0, 10))}
        keyboardType="phone-pad"
        placeholder="97345 67890"
        prefix="+91"
      />
      <PrimaryButton label="Save profile" onPress={() => void saveProfile()} disabled={saving} loading={saving} />
    </>
  );
}

function normalizeMobileNumber(value: string) {
  const digits = value.replace(/\D/g, "");
  return digits.startsWith("91") && digits.length > 10 ? digits.slice(2, 12) : digits.slice(0, 10);
}

export function DocumentsForm() {
  const colors = useColors();
  const { showModal } = useModal();
  const [document, setDocument] = useState<UserDocument | null>(null);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    getDocuments()
      .then((items) => {
        const next = items[0] ?? null;
        setDocument((current) => current ?? next);
        setImageLoading(Boolean(next));
        setImageError(false);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  const chooseImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsEditing: true, quality: 0.8 });
    if (result.canceled || !result.assets[0]) return;
    setPreviewUri(result.assets[0].uri);
    setImageLoading(true);
    setImageError(false);
  };

  const saveDocument = async () => {
    if (!previewUri) return;
    try {
      setSaving(true);
      const url = await uploadImageToImageKit(previewUri, "aadhaar.jpg", "image/jpeg");
      setDocument(await saveAadhaar(url));
      setPreviewUri(null);
      setImageLoading(true);
      setImageError(false);
      showModal({ type: "success", title: "Saved", message: "Your Aadhaar image was saved." });
    } catch (error) {
      showModal({ type: "error", title: "Upload failed", message: error instanceof Error ? error.message : "Unable to upload image." });
    } finally { setSaving(false); }
  };

  return (
    <>
      <Text style={[styles.help, { color: colors.mutedForeground }]}>Upload your Aadhaar Card photo only. PDF files are not accepted.</Text>
      {loading ? (
        <LoadingState label="Loading Aadhaar image..." />
      ) : previewUri || document ? (
        <View style={styles.documentImageWrap}>
          <Image
            source={{ uri: previewUri ?? document?.imageUrl }}
            style={styles.document}
            onLoadStart={() => setImageLoading(true)}
            onLoad={() => setImageLoading(false)}
            onError={() => {
              setImageLoading(false);
              setImageError(true);
            }}
          />
          {imageLoading ? (
            <View style={styles.documentLoader}>
              <ActivityIndicator size="small" color={colors.primary} />
            </View>
          ) : null}
        </View>
      ) : null}
      {imageError ? (
        <Text style={[styles.help, { color: colors.destructive }]}>
          Unable to load the Aadhaar image.
        </Text>
      ) : null}
      <View style={{ marginVertical: 20 }}>
      {!loading && !previewUri ? (
        <PrimaryButton
          label={document ? "Replace Aadhaar photo" : "Upload Aadhaar photo"}
          icon="upload"
          onPress={() => void chooseImage()}
          disabled={saving}
        />
      ) : null}
      {previewUri ? (
        <PrimaryButton
          label={saving ? "Saving Aadhaar photo..." : "Save Aadhaar photo"}
          icon="check"
          onPress={() => void saveDocument()}
          disabled={saving}
          loading={saving}
        />
      ) : null}
      </View>
    </>
  );
}

export function PasswordForm() {
  const { showModal } = useModal();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const changePassword = async () => {
    if (newPassword !== confirmPassword) { showModal({ type: "error", title: "Unable to update", message: "New passwords do not match." }); return; }
    try {
      setSaving(true);
      await updatePassword({ currentPassword, newPassword });
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
      showModal({ type: "success", title: "Updated", message: "Your password has been changed." });
    } catch (error) {
      showModal({ type: "error", title: "Unable to update", message: error instanceof Error ? error.message : "Please try again." });
    } finally { setSaving(false); }
  };
  return (
    <>
      <Field label="Current password" value={currentPassword} onChangeText={setCurrentPassword} secureTextEntry />
      <Field label="New password" value={newPassword} onChangeText={setNewPassword} secureTextEntry />
      <Field label="Confirm password" value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry />
      <PrimaryButton label="Update password" onPress={() => void changePassword()} disabled={saving || !currentPassword || !newPassword || !confirmPassword} />
    </>
  );
}

const styles = StyleSheet.create({
  profileRow: { alignItems: "center", gap: 14, marginBottom: 20 },
  documentImageWrap: { position: "relative", width: "100%", height: 190 },
  document: { width: "100%", height: 190, borderRadius: 18, marginVertical: 12 },
  documentLoader: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(0,0,0,0.22)",
    borderRadius: 18,
    marginVertical: 12,
  },
  help: { ...fonts.regular, fontSize: 12, lineHeight: 18, marginBottom: 15 },
});