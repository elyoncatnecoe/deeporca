package com.elyoncat.deepsea;

/**
 * DeepSeekHashV1 —— chat.deepseek.com 发消息前要求的工作量证明（Java 版）。
 *
 * 算法：SHA3-256 的 sponge（rate 136、domain 0x06、32 字节摘要），但置换只跑
 * 23 轮（FIPS 202 的 KECCAK-p[1600,24] 跳过第 0 轮）。
 *
 * 为什么要在 Java 里手写：手机端要做到「关掉网页窗也能聊」，就不能借 WebView
 * 的 JS 引擎算 PoW。而 minSdk 是 23（Android 6），java.security.MessageDigest
 * 在那个版本上还不支持 SHA3，何况 DeepSeekHashV1 是 23 轮、本来就不是标准 SHA3。
 *
 * 实现与桌面端 electron/pow.ts 逐行对应，那边的 SHA3-256（24 轮）已与
 * node:crypto 交叉验证过；这里用 long 承载 64 位 lane（Java 的 long 是带符号的，
 * 所有移位/异或按位操作与无符号等价，比较时用位运算而非大小）。
 */
final class DeepSeekPow {
    private static final int RATE = 136;
    private static final int OUT = 32;
    /** DeepSeekHashV1 用 23 轮。 */
    private static final int ROUNDS = 23;
    /** 难度上限：厂商通常给 144000，设个界防止恶意挑战把机器钉死。 */
    static final long MAX_DIFFICULTY = 5_000_000L;

    /** 按 x + 5*y 索引，与 FIPS 202 的状态坐标一致。 */
    private static final int[] ROTATION = {
        0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
    };

    private static final long[] RC = {
        0x0000000000000001L, 0x0000000000008082L, 0x800000000000808aL, 0x8000000080008000L,
        0x000000000000808bL, 0x0000000080000001L, 0x8000000080008081L, 0x8000000000008009L,
        0x000000000000008aL, 0x0000000000000088L, 0x0000000080008009L, 0x000000008000000aL,
        0x000000008000808bL, 0x800000000000008bL, 0x8000000000008089L, 0x8000000000008003L,
        0x8000000000008002L, 0x8000000000000080L, 0x000000000000800aL, 0x800000008000000aL,
        0x8000000080008081L, 0x8000000000008080L, 0x0000000080000001L, 0x8000000080008008L,
    };

    private DeepSeekPow() {}

    private static long rotl(long value, int amount) {
        if (amount == 0) return value;
        return (value << amount) | (value >>> (64 - amount));
    }

    /** KECCAK-p[1600,24] 的后 rounds 轮；DeepSeekHashV1 跳过第 0 轮。 */
    private static void permute(long[] state, int rounds) {
        long[] columnParity = new long[5];
        long[] thetaMix = new long[5];
        long[] rhoPi = new long[25];
        for (int round = RC.length - rounds; round < RC.length; round++) {
            for (int x = 0; x < 5; x++) {
                columnParity[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
            }
            for (int x = 0; x < 5; x++) {
                thetaMix[x] = columnParity[(x + 4) % 5] ^ rotl(columnParity[(x + 1) % 5], 1);
            }
            for (int y = 0; y < 5; y++) {
                for (int x = 0; x < 5; x++) state[x + 5 * y] ^= thetaMix[x];
            }
            for (int y = 0; y < 5; y++) {
                for (int x = 0; x < 5; x++) {
                    int destinationX = y;
                    int destinationY = (2 * x + 3 * y) % 5;
                    int lane = x + 5 * y;
                    rhoPi[destinationX + 5 * destinationY] = rotl(state[lane], ROTATION[lane]);
                }
            }
            for (int y = 0; y < 5; y++) {
                int row = 5 * y;
                for (int x = 0; x < 5; x++) {
                    state[x + row] = rhoPi[x + row] ^ (~rhoPi[((x + 1) % 5) + row] & rhoPi[((x + 2) % 5) + row]);
                }
            }
            state[0] ^= RC[round];
        }
    }

    private static void absorb(long[] state, byte[] bytes, int offset, int rounds) {
        for (int index = 0; index < RATE; index++) {
            int lane = index >>> 3;
            state[lane] ^= ((long) (bytes[offset + index] & 0xFF)) << ((index & 7) * 8);
        }
        permute(state, rounds);
    }

    /**
     * 解一道挑战：在 [0, difficulty) 里找摘要等于 challenge 的 nonce。
     *
     * 前缀（salt_expireAt_）只吸收一次，之后每个候选只把 nonce 的字节折进去，
     * 和厂商自己的解算器做法一致。
     *
     * @return 找到的 nonce；解不出返回 -1
     */
    static long solve(String salt, long expireAt, String target, long difficulty) {
        if (difficulty < 1) return -1;
        if (difficulty > MAX_DIFFICULTY) return -1;

        String prefix = salt + "_" + expireAt + "_";
        byte[] prefixBytes = prefix.getBytes(java.nio.charset.StandardCharsets.UTF_8);

        long[] baseState = new long[25];
        int offset = 0;
        while (offset + RATE <= prefixBytes.length) {
            absorb(baseState, prefixBytes, offset, ROUNDS);
            offset += RATE;
        }
        int tailLength = prefixBytes.length - offset;
        long[] tail = new long[(tailLength + 7) / 8];
        for (int index = 0; index < tailLength; index++) {
            tail[index >>> 3] ^= ((long) (prefixBytes[offset + index] & 0xFF)) << ((index & 7) * 8);
        }

        // 目标摘要按小端拆成 4 个 long，比较时逐 lane 比。
        long[] targetLanes = new long[OUT / 8];
        for (int index = 0; index < OUT; index++) {
            int hi = Character.digit(target.charAt(index * 2), 16);
            int lo = Character.digit(target.charAt(index * 2 + 1), 16);
            if (hi < 0 || lo < 0) return -1;
            int value = (hi << 4) | lo;
            targetLanes[index >>> 3] |= ((long) value) << ((index & 7) * 8);
        }

        long[] state = new long[25];
        for (long nonce = 0; nonce < difficulty; nonce++) {
            System.arraycopy(baseState, 0, state, 0, 25);
            for (int lane = 0; lane < tail.length; lane++) state[lane] ^= tail[lane];

            int position = tailLength;
            String text = Long.toString(nonce);
            for (int index = 0; index < text.length(); index++) {
                state[position >>> 3] ^= ((long) text.charAt(index)) << ((position & 7) * 8);
                position++;
                if (position == RATE) {
                    permute(state, ROUNDS);
                    position = 0;
                }
            }
            state[position >>> 3] ^= 0x06L << ((position & 7) * 8);
            state[(RATE - 1) >>> 3] ^= 0x80L << 56;
            permute(state, ROUNDS);

            boolean matched = true;
            for (int lane = 0; lane < targetLanes.length; lane++) {
                if (state[lane] != targetLanes[lane]) { matched = false; break; }
            }
            if (matched) return nonce;
        }
        return -1;
    }

    /** 拼 x-ds-pow-response 头（base64 的 JSON）。 */
    static String header(String algorithm, String challenge, String salt, long answer, String signature, String targetPath) {
        try {
            org.json.JSONObject payload = new org.json.JSONObject();
            payload.put("algorithm", algorithm);
            payload.put("challenge", challenge);
            payload.put("salt", salt);
            payload.put("answer", answer);
            payload.put("signature", signature);
            payload.put("target_path", targetPath);
            return android.util.Base64.encodeToString(
                payload.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8),
                android.util.Base64.NO_WRAP);
        } catch (Exception error) {
            return null;
        }
    }
}