"use server";
import { runAction } from "@/lib/action-guard";
import {
  notificationSettings,
  subscribeDevice,
  unsubscribeDevice,
  removeDevice,
  enqueueTestNotification,
  type NotificationSubscription,
} from "@/lib/push";

export async function getNotificationSettings() {
  return runAction(() => notificationSettings());
}
export async function subscribeNotifications(
  input: NotificationSubscription,
  name: string,
) {
  return runAction(() => subscribeDevice(input, name));
}
export async function unsubscribeNotifications(endpoint: string) {
  return runAction(() => unsubscribeDevice(endpoint));
}
export async function removeNotificationDevice(id: number) {
  return runAction(() => removeDevice(id));
}
export async function sendTestNotification(endpoint: string) {
  return runAction(() => enqueueTestNotification(endpoint));
}
