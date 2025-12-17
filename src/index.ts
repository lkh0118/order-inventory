import "dotenv/config";
import express from "express";
import { z } from "zod";
import { prisma } from "./prisma";

const app = express();
app.use(express.json());                                                    //JSON Read

// 0) 서버가 살아있는지 확인
app.get("/health", (_req, res) => {
    res.json({ok: true});
});

// 1) 제품 등록
const createProductBody = z.object({
    sku: z.string().min(1),
    name: z.string().min(1),
    price: z.number().int().nonnegative(),
});

app.post("/products", async (req, res) => {
    const parsed = createProductBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    try {
        const created = await prisma.$transaction(async (tx) => {
            const product = await prisma.product.create({
            data: {
                sku: parsed.data.sku,
                name: parsed.data.name,
                price: parsed.data.price,
                },
            });

            const stock = await tx.stock.create({
                data: { productId: product.id, quantity: 0 },
            });

            return { ...product, stock };
        });

        res.status(201).json(created);
    } catch (e: any) {
        res.status(400).json({ message: e?.message ?? "Create product failed" });
    }
});

// 2) 제품 목록 조회
app.get("/products", async (_req, res) => {
    const products = await prisma.product.findMany({
        include: { stock: true },
        orderBy: { id: "asc" },
    });

    res.json(products);
});

// 3) 재고 조정(입고 / 차감)
const adjustStockBody = z.object({
    sku: z.string().min(1),
    delta: z.number().int(),
    reason: z.string().min(1),
});

app.post("/inventory/adjust", async (req, res) => {
    const parsed = adjustStockBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    const { sku, delta, reason } = parsed.data;

    try {
        const result = await prisma.$transaction(async (tx) => {

            // 1) 제품은 반드시 목록에 있어야 함
            const product = await tx.product.findUnique({ where: { sku } });
            if (!product) throw new Error("Product not found");

            // 2) Stock가 없다면 자동으로 생성 (기본 값 0)
            const stock = await tx.stock.upsert({
                where: { productId: product.id },
                create: { productId: product.id, quantity: 0 },
                update: {},
            });

            if (product.stockProductId == null) {
                await tx.product.update({
                    where: { id: product.id },
                    data: {
                        stock: { connect: { productId: product.id } },
                    },
                });
            }

            // 3) 수량 계산 및 검증
            const nextQty = stock.quantity + delta;
            if (nextQty < 0) throw new Error("Stock cannot go below 0");

            // 4) 재고 업데이트
            const updatedStock = await tx.stock.update({
                where: { productId: product.id },
                data: { quantity: nextQty },
            });
            
            // 5) 이력 남기기
            const movement = await tx.stockMovement.create({
                data: { productId: product.id, delta, reason },
            });

            return { product, stock: updatedStock, movement };
        });

        res.json(result);
    } catch (e: any) {
        res.status(400).json({ message: e?.message ?? "Adjust stock failed" });
    }
});

// 4) 주문 생성 (재고 차감 + 주문/항목 저장)
const createOrderBody = z.object({
    items: z.array(
        z.object({
            sku: z.string().min(1),
            qty: z.number().int().positive(),
        })
    ).min(1),
});

app.post("/orders", async (req, res) => {
    const parsed = createOrderBody.safeParse(req.body);
    if (!parsed.success) return res.status(400).json(parsed.error.flatten());

    try {
        const created = await prisma.$transaction(async (tx) => {
            const skus = parsed.data.items.map((i) => i.sku);

            const products = await tx.product.findMany({
                where: { sku: { in: skus } },
                include: { stock: true },
            });

            const map = new Map(products.map((p) => [p.sku, p]));

            let total = 0;
            for (const item of parsed.data.items) {
                const p = map.get(item.sku);
                if (!p || !p.stock) throw new Error(`Product not found: ${item.sku}`);

                const nextQty = p.stock.quantity - item.qty;
                if (nextQty < 0) throw new Error(`Not enough stock for: ${item.sku}`);

                total += p.price * item.qty;
            }

            const order = await tx.order.create({
                data: { totalPrice: total },
            });

            for (const item of parsed.data.items) {
                const p = map.get(item.sku)!;

                await tx.orderItem.create({
                    data: {
                        orderId: order.id,
                        productId: p.id,
                        qty: item.qty,
                        unitPrice: p.price,
                        lineTotal: p.price * item.qty,
                    },
                });

                await tx.stock.update({
                    where: { productId: p.id },
                    data: { quantity: p.stock!.quantity - item.qty },
                });

                await tx.stockMovement.create({
                    data: {
                        productId: p.id,
                        delta: -item.qty,
                        reason: `Order#${order.id}`,
                    },
                });
            }
            
            return tx.order.findUnique({
                where: { id: order.id },
                include: { items: { include: { product: true } } },
            });
        });

        res.status(400).json(created);
    } catch (e: any) {
        res.status(400).json({ message: e?.message ?? "Create order failed" });
    }
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`API running on http://localhost:${port}`));
