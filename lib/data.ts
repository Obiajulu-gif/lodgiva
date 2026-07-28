// Seed data for the Lodgiva demo dashboard.
// In production this data comes from the Lodgiva API (NestJS + PostgreSQL).

export type RoomStatus =
  | "VACANT_CLEAN"
  | "VACANT_DIRTY"
  | "OCCUPIED_CLEAN"
  | "OCCUPIED_DIRTY"
  | "INSPECTED"
  | "OUT_OF_ORDER";

export type ReservationStatus =
  | "CONFIRMED"
  | "CHECKED_IN"
  | "CHECKED_OUT"
  | "PENDING_PAYMENT"
  | "CANCELLED"
  | "NO_SHOW";

export interface Room {
  id: string;
  number: string;
  type: string;
  floor: number;
  status: RoomStatus;
  rate: number; // naira per night
  guest?: string;
}

export interface Reservation {
  id: string;
  code: string;
  guest: string;
  room: string;
  roomType: string;
  arrival: string;
  departure: string;
  nights: number;
  adults: number;
  status: ReservationStatus;
  total: number;
  balance: number;
  source: string;
}

export interface Guest {
  id: string;
  name: string;
  phone: string;
  email: string;
  nationality: string;
  stays: number;
  lifetimeSpend: number;
  lastStay: string;
  vip: boolean;
}

export interface Payment {
  id: string;
  reference: string;
  guest: string;
  folio: string;
  method: "Card" | "Bank Transfer" | "Cash" | "POS Terminal" | "Payment Link";
  provider: string;
  amount: number;
  status: "Confirmed" | "Pending" | "Refunded" | "Failed";
  date: string;
}

export interface HousekeepingTask {
  id: string;
  room: string;
  type: "Full Clean" | "Turnover" | "Inspection" | "Deep Clean" | "Maintenance";
  assignee: string;
  priority: "High" | "Normal" | "Low";
  status: "Pending" | "In Progress" | "Completed" | "Inspected";
  notes?: string;
}

export const kpis = {
  occupancy: 82,
  adr: 46500,
  revpar: 38130,
  roomsSold: 41,
  totalRooms: 50,
  arrivalsToday: 9,
  departuresToday: 6,
  inHouse: 41,
  revenueToday: 1906500,
  revenueMTD: 48230000,
  outstandingBalance: 1245000,
  pendingReconciliation: 3,
};

export const occupancyTrend = [
  { day: "Mon", value: 68 },
  { day: "Tue", value: 71 },
  { day: "Wed", value: 75 },
  { day: "Thu", value: 79 },
  { day: "Fri", value: 91 },
  { day: "Sat", value: 96 },
  { day: "Sun", value: 82 },
];

export const revenueByOutlet = [
  { outlet: "Rooms", value: 1420000 },
  { outlet: "Restaurant", value: 286500 },
  { outlet: "Bar & Lounge", value: 138000 },
  { outlet: "Laundry", value: 42000 },
  { outlet: "Events Hall", value: 20000 },
];

const roomTypes = [
  { type: "Standard", rate: 35000 },
  { type: "Deluxe", rate: 46500 },
  { type: "Executive", rate: 62000 },
  { type: "Suite", rate: 95000 },
];

const guestNames = [
  "Adaeze Okonkwo", "Tunde Bakare", "Chiamaka Eze", "Ibrahim Musa",
  "Funke Adeyemi", "Emeka Nwosu", "Zainab Bello", "Olusegun Adebayo",
  "Ngozi Chukwu", "Yusuf Abdullahi", "Blessing Okafor", "Kunle Ojo",
  "Amina Sani", "Chinedu Obi", "Folake Williams", "David Osei",
  "Grace Etim", "Hassan Garba", "Ifeoma Nnamdi", "Segun Fashola",
];

const statuses: RoomStatus[] = [
  "OCCUPIED_CLEAN", "OCCUPIED_CLEAN", "OCCUPIED_DIRTY", "OCCUPIED_CLEAN",
  "VACANT_CLEAN", "INSPECTED", "OCCUPIED_CLEAN", "VACANT_DIRTY",
  "OCCUPIED_CLEAN", "OCCUPIED_DIRTY",
];

export const rooms: Room[] = Array.from({ length: 50 }, (_, i) => {
  const floor = Math.floor(i / 10) + 1;
  const number = `${floor}${String(i % 10).padStart(2, "0")}`;
  const rt = roomTypes[floor === 5 ? 3 : floor === 4 ? 2 : floor >= 2 ? 1 : 0];
  const status =
    i === 17 ? "OUT_OF_ORDER" : statuses[(i * 7 + floor) % statuses.length];
  const occupied = status.startsWith("OCCUPIED");
  return {
    id: `rm_${number}`,
    number,
    type: rt.type,
    floor,
    status,
    rate: rt.rate,
    guest: occupied ? guestNames[i % guestNames.length] : undefined,
  };
});

export const reservations: Reservation[] = [
  { id: "res_01", code: "LDG-4821", guest: "Adaeze Okonkwo", room: "302", roomType: "Deluxe", arrival: "2026-07-28", departure: "2026-07-31", nights: 3, adults: 2, status: "CHECKED_IN", total: 139500, balance: 0, source: "Direct" },
  { id: "res_02", code: "LDG-4822", guest: "Tunde Bakare", room: "415", roomType: "Executive", arrival: "2026-07-28", departure: "2026-07-30", nights: 2, adults: 1, status: "CHECKED_IN", total: 124000, balance: 62000, source: "Walk-in" },
  { id: "res_03", code: "LDG-4823", guest: "Chiamaka Eze", room: "506", roomType: "Suite", arrival: "2026-07-29", departure: "2026-08-02", nights: 4, adults: 2, status: "CONFIRMED", total: 380000, balance: 380000, source: "Booking Engine" },
  { id: "res_04", code: "LDG-4824", guest: "Ibrahim Musa", room: "108", roomType: "Standard", arrival: "2026-07-28", departure: "2026-07-29", nights: 1, adults: 1, status: "CHECKED_IN", total: 35000, balance: 0, source: "Phone" },
  { id: "res_05", code: "LDG-4825", guest: "Funke Adeyemi", room: "210", roomType: "Deluxe", arrival: "2026-07-30", departure: "2026-08-01", nights: 2, adults: 2, status: "PENDING_PAYMENT", total: 93000, balance: 93000, source: "Booking Engine" },
  { id: "res_06", code: "LDG-4826", guest: "Emeka Nwosu", room: "301", roomType: "Deluxe", arrival: "2026-07-25", departure: "2026-07-28", nights: 3, adults: 1, status: "CHECKED_OUT", total: 139500, balance: 0, source: "Corporate" },
  { id: "res_07", code: "LDG-4827", guest: "Zainab Bello", room: "402", roomType: "Executive", arrival: "2026-07-29", departure: "2026-07-31", nights: 2, adults: 2, status: "CONFIRMED", total: 124000, balance: 62000, source: "Direct" },
  { id: "res_08", code: "LDG-4828", guest: "Olusegun Adebayo", room: "—", roomType: "Suite", arrival: "2026-07-27", departure: "2026-07-28", nights: 1, adults: 1, status: "NO_SHOW", total: 95000, balance: 95000, source: "Booking Engine" },
  { id: "res_09", code: "LDG-4829", guest: "Ngozi Chukwu", room: "205", roomType: "Deluxe", arrival: "2026-08-01", departure: "2026-08-05", nights: 4, adults: 2, status: "CONFIRMED", total: 186000, balance: 93000, source: "Corporate" },
  { id: "res_10", code: "LDG-4830", guest: "Yusuf Abdullahi", room: "—", roomType: "Standard", arrival: "2026-07-26", departure: "2026-07-27", nights: 1, adults: 1, status: "CANCELLED", total: 35000, balance: 0, source: "Phone" },
];

export const guests: Guest[] = [
  { id: "gst_01", name: "Adaeze Okonkwo", phone: "+234 803 456 7890", email: "adaeze.o@example.com", nationality: "Nigerian", stays: 8, lifetimeSpend: 1240000, lastStay: "2026-07-28", vip: true },
  { id: "gst_02", name: "Tunde Bakare", phone: "+234 805 123 4567", email: "tunde.b@example.com", nationality: "Nigerian", stays: 3, lifetimeSpend: 372000, lastStay: "2026-07-28", vip: false },
  { id: "gst_03", name: "Chiamaka Eze", phone: "+234 812 987 6543", email: "chiamaka.e@example.com", nationality: "Nigerian", stays: 12, lifetimeSpend: 2860000, lastStay: "2026-06-14", vip: true },
  { id: "gst_04", name: "Ibrahim Musa", phone: "+234 806 234 5678", email: "ibrahim.m@example.com", nationality: "Nigerian", stays: 1, lifetimeSpend: 35000, lastStay: "2026-07-28", vip: false },
  { id: "gst_05", name: "Funke Adeyemi", phone: "+234 809 345 6789", email: "funke.a@example.com", nationality: "Nigerian", stays: 5, lifetimeSpend: 651000, lastStay: "2026-05-02", vip: false },
  { id: "gst_06", name: "Emeka Nwosu", phone: "+234 813 456 7890", email: "emeka.n@corporatehq.ng", nationality: "Nigerian", stays: 22, lifetimeSpend: 4120000, lastStay: "2026-07-25", vip: true },
  { id: "gst_07", name: "Zainab Bello", phone: "+234 807 567 8901", email: "zainab.b@example.com", nationality: "Nigerian", stays: 2, lifetimeSpend: 248000, lastStay: "2026-03-19", vip: false },
  { id: "gst_08", name: "David Osei", phone: "+233 24 456 7890", email: "david.o@example.com", nationality: "Ghanaian", stays: 4, lifetimeSpend: 590000, lastStay: "2026-04-11", vip: false },
];

export const payments: Payment[] = [
  { id: "pay_01", reference: "PSK-88214X", guest: "Adaeze Okonkwo", folio: "F-2201", method: "Card", provider: "Paystack", amount: 139500, status: "Confirmed", date: "2026-07-28 09:14" },
  { id: "pay_02", reference: "TRF-00921A", guest: "Tunde Bakare", folio: "F-2202", method: "Bank Transfer", provider: "GTBank", amount: 62000, status: "Confirmed", date: "2026-07-28 10:02" },
  { id: "pay_03", reference: "CSH-000451", guest: "Ibrahim Musa", folio: "F-2203", method: "Cash", provider: "Front Desk", amount: 35000, status: "Confirmed", date: "2026-07-28 08:40" },
  { id: "pay_04", reference: "FLW-33019B", guest: "Chiamaka Eze", folio: "F-2204", method: "Payment Link", provider: "Flutterwave", amount: 190000, status: "Pending", date: "2026-07-28 11:25" },
  { id: "pay_05", reference: "POS-77120", guest: "Emeka Nwosu", folio: "F-2198", method: "POS Terminal", provider: "Moniepoint", amount: 139500, status: "Confirmed", date: "2026-07-27 18:55" },
  { id: "pay_06", reference: "PSK-88190Q", guest: "Funke Adeyemi", folio: "F-2205", method: "Card", provider: "Paystack", amount: 46500, status: "Refunded", date: "2026-07-26 14:30" },
  { id: "pay_07", reference: "TRF-00899Z", guest: "Zainab Bello", folio: "F-2206", method: "Bank Transfer", provider: "Zenith Bank", amount: 62000, status: "Pending", date: "2026-07-28 12:11" },
];

export const housekeepingTasks: HousekeepingTask[] = [
  { id: "hk_01", room: "104", type: "Turnover", assignee: "Mary Johnson", priority: "High", status: "In Progress", notes: "Guest arriving 2pm" },
  { id: "hk_02", room: "207", type: "Full Clean", assignee: "Peter Adamu", priority: "Normal", status: "Pending" },
  { id: "hk_03", room: "302", type: "Inspection", assignee: "Rita Okoro", priority: "Normal", status: "Completed" },
  { id: "hk_04", room: "118", type: "Deep Clean", assignee: "Mary Johnson", priority: "Low", status: "Pending", notes: "Quarterly schedule" },
  { id: "hk_05", room: "415", type: "Turnover", assignee: "Peter Adamu", priority: "High", status: "Pending", notes: "VIP arrival" },
  { id: "hk_06", room: "501", type: "Full Clean", assignee: "Rita Okoro", priority: "Normal", status: "In Progress" },
  { id: "hk_07", room: "203", type: "Maintenance", assignee: "Engr. Bassey", priority: "High", status: "In Progress", notes: "AC not cooling" },
  { id: "hk_08", room: "310", type: "Inspection", assignee: "Rita Okoro", priority: "Normal", status: "Inspected" },
];

export function formatNaira(amount: number): string {
  return `₦${amount.toLocaleString("en-NG")}`;
}
