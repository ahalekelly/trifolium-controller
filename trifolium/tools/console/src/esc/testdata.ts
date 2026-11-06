// am32-configurator's default settings blocks (public/eeprom-defaults/DEFAULT/, commit 06955fe):
// real AM32 settings images, so a table that misplaces a field reads nonsense out of them.

const decode = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/** Layout 4, firmware 2.21. Its byte 13 still holds a name character AM32 resets to 0. */
export const V4_DEFAULT = decode(
  "AQQBAhWgBAAKZAAyAgA1MSAAAAABAQEaGGQ3DgAABQCAgIAyADIAAA8KCo1mBgEA////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////////////////" +
  "////////////////////////////////////////////////////////////////////////////////",
);

/** Layout 2, which kept the firmware's name in bytes 5-16. Its first 48 bytes only. */
export const V2_DEFAULT = decode(
  "AQIBASNORU9FU0MgZjA1MSAAAAABAQECGGQ3DgAABQCAgIAyADIAAA8KCo1mBgAA",
);
