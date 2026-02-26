import {
  serializeMessageToCanonical,
  serializeMessagesToCanonical,
} from "../../chat/_shared/message_contract";

export const serializeGroupMessage = (value: any) =>
  serializeMessageToCanonical(value, { includeLegacy: true });

export const serializeGroupMessages = (values: any[]) =>
  serializeMessagesToCanonical(values, { includeLegacy: true });
