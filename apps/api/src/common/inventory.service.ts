import { ConflictException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma.service";
import { nightsBetween } from "./money";

type Tx = Prisma.TransactionClient;

/**
 * Concurrency-safe inventory allocation.
 *
 * Availability is not "capacity minus a COUNT(*)" — that pattern is a
 * check-then-act race: two requests can both read 1 remaining and both write.
 * Instead every sold room-night takes an explicit slot in [0, capacity), and
 * the database holds a unique constraint on (roomTypeId, date, slotIndex).
 * Two concurrent bookings for the last room therefore contend on the same
 * unique index and exactly one wins — an invariant enforced by the database,
 * not by transaction isolation or by application ordering.
 *
 * Blocked rooms reduce capacity for the dates they cover, so a block can never
 * be sold over.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  /** Physical rooms of a type, minus rooms blocked on the given night. */
  async capacityForNight(
    tx: Tx | PrismaService,
    input: { tenantId: string; roomTypeId: string; date: string }
  ): Promise<number> {
    const total = await tx.room.count({
      where: { tenantId: input.tenantId, roomTypeId: input.roomTypeId },
    });
    const blocked = await tx.roomBlock.count({
      where: {
        tenantId: input.tenantId,
        status: "ACTIVE",
        startDate: { lte: input.date },
        endDate: { gt: input.date },
        room: { roomTypeId: input.roomTypeId },
      },
    });
    return Math.max(0, total - blocked);
  }

  /** Slots already taken, ignoring holds that have expired. */
  private async takenSlots(
    tx: Tx | PrismaService,
    input: { tenantId: string; roomTypeId: string; date: string }
  ): Promise<Set<number>> {
    const rows = await tx.roomNightAllocation.findMany({
      where: {
        tenantId: input.tenantId,
        roomTypeId: input.roomTypeId,
        date: input.date,
        // An allocation counts if it belongs to a confirmed stay, or to a hold
        // that is still active and unexpired.
        OR: [
          { reservationRoomId: { not: null } },
          { hold: { status: "ACTIVE", expiresAt: { gt: new Date() } } },
        ],
      },
      select: { slotIndex: true },
    });
    return new Set(rows.map((r) => r.slotIndex));
  }

  /**
   * Remaining sellable rooms per night across a range. Used by availability
   * and quoting; the authoritative check is still the allocation insert.
   */
  async availabilityByNight(
    input: { tenantId: string; roomTypeId: string; arrival: string; departure: string },
    tx: Tx | PrismaService = this.prisma
  ): Promise<{ date: string; capacity: number; sold: number; available: number }[]> {
    const out = [];
    for (const date of nightsBetween(input.arrival, input.departure)) {
      const capacity = await this.capacityForNight(tx, {
        tenantId: input.tenantId,
        roomTypeId: input.roomTypeId,
        date,
      });
      const taken = await this.takenSlots(tx, {
        tenantId: input.tenantId,
        roomTypeId: input.roomTypeId,
        date,
      });
      out.push({
        date,
        capacity,
        sold: taken.size,
        available: Math.max(0, capacity - taken.size),
      });
    }
    return out;
  }

  /**
   * Claims one slot for every night in the range, owned by either a hold or a
   * reservation room. Must run inside a transaction so a partial stay is never
   * left allocated.
   *
   * Returns the allocated slot indices. Throws 409 when any night is sold out.
   */
  async allocateStay(
    tx: Tx,
    input: {
      tenantId: string;
      propertyId: string;
      roomTypeId: string;
      arrival: string;
      departure: string;
      holdId?: string;
      reservationRoomId?: string;
      /** Slots owned by this hold may be reused when converting hold → stay. */
      consumingHoldId?: string;
    }
  ): Promise<{ date: string; slotIndex: number }[]> {
    const claimed: { date: string; slotIndex: number }[] = [];

    for (const date of nightsBetween(input.arrival, input.departure)) {
      const capacity = await this.capacityForNight(tx, {
        tenantId: input.tenantId,
        roomTypeId: input.roomTypeId,
        date,
      });
      if (capacity === 0) {
        throw new ConflictException({
          error: {
            code: "SOLD_OUT",
            message: `No sellable rooms of this type on ${date}.`,
            retryable: false,
            details: { date },
          },
        });
      }

      // Converting a hold: take over the slot the hold already owns rather
      // than competing for a new one.
      if (input.consumingHoldId) {
        const owned = await tx.roomNightAllocation.findFirst({
          where: {
            tenantId: input.tenantId,
            roomTypeId: input.roomTypeId,
            date,
            holdId: input.consumingHoldId,
          },
        });
        if (owned) {
          await tx.roomNightAllocation.update({
            where: { id: owned.id },
            data: { holdId: null, reservationRoomId: input.reservationRoomId },
          });
          claimed.push({ date, slotIndex: owned.slotIndex });
          continue;
        }
      }

      const taken = await this.takenSlots(tx, {
        tenantId: input.tenantId,
        roomTypeId: input.roomTypeId,
        date,
      });
      let placed = false;
      for (let slot = 0; slot < capacity; slot++) {
        if (taken.has(slot)) continue;
        try {
          await tx.roomNightAllocation.create({
            data: {
              tenantId: input.tenantId,
              propertyId: input.propertyId,
              roomTypeId: input.roomTypeId,
              date,
              slotIndex: slot,
              holdId: input.holdId,
              reservationRoomId: input.reservationRoomId,
            },
          });
          claimed.push({ date, slotIndex: slot });
          placed = true;
          break;
        } catch (e: unknown) {
          // P2002 = another request won this slot. Try the next one; this is
          // the race being resolved by the database rather than by us.
          if ((e as { code?: string }).code !== "P2002") throw e;

          // The loser of a race may find a stale row from an expired hold
          // sitting on the slot; reclaim it rather than skipping the slot.
          const stale = await tx.roomNightAllocation.findFirst({
            where: {
              roomTypeId: input.roomTypeId,
              date,
              slotIndex: slot,
              reservationRoomId: null,
              hold: { OR: [{ status: { not: "ACTIVE" } }, { expiresAt: { lte: new Date() } }] },
            },
          });
          if (stale) {
            await tx.roomNightAllocation.update({
              where: { id: stale.id },
              data: {
                holdId: input.holdId ?? null,
                reservationRoomId: input.reservationRoomId ?? null,
              },
            });
            claimed.push({ date, slotIndex: slot });
            placed = true;
            break;
          }
        }
      }

      if (!placed) {
        throw new ConflictException({
          error: {
            code: "SOLD_OUT",
            message: `All ${capacity} room(s) of this type are sold on ${date}.`,
            retryable: false,
            details: { date, capacity },
          },
        });
      }
    }

    return claimed;
  }

  /** Frees every slot owned by a hold (release, expiry or cancellation). */
  async releaseHold(tx: Tx, holdId: string) {
    await tx.roomNightAllocation.deleteMany({ where: { holdId } });
  }

  /** Frees every slot owned by a reservation room (cancel, no-show, release). */
  async releaseReservationRoom(tx: Tx, reservationRoomId: string) {
    await tx.roomNightAllocation.deleteMany({ where: { reservationRoomId } });
  }

  /**
   * Marks expired holds and frees their inventory. Called on read paths and by
   * the worker, so inventory recovers even if the sweeper is not running.
   */
  async expireStaleHolds(tenantId?: string): Promise<number> {
    const stale = await this.prisma.hold.findMany({
      where: {
        status: "ACTIVE",
        expiresAt: { lte: new Date() },
        ...(tenantId ? { tenantId } : {}),
      },
      select: { id: true },
      take: 200,
    });
    if (stale.length === 0) return 0;
    await this.prisma.$transaction(async (tx) => {
      for (const h of stale) {
        await tx.roomNightAllocation.deleteMany({ where: { holdId: h.id } });
        await tx.hold.update({ where: { id: h.id }, data: { status: "EXPIRED" } });
      }
    });
    return stale.length;
  }
}
