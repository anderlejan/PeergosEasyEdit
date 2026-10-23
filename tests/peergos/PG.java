import peergos.server.Builder;
import peergos.shared.Crypto;
import peergos.shared.NetworkAccess;
import peergos.shared.user.UserContext;
import peergos.shared.user.fs.AsyncReader;
import peergos.shared.user.fs.FileWrapper;

import java.net.URI;
import java.nio.file.*;
import java.util.*;

/** Test helper for a LOCAL throw-away Peergos server: ground truth independent of the app.
 *  The password comes from the environment (PEERGOS_TEST_PASSWORD), never from the command line.
 *  java -cp Peergos.jar tests/peergos/PG.java <url> <user> put <folder> <name> <localFile>
 *  java -cp Peergos.jar tests/peergos/PG.java <url> <user> cat <path> <outFile>
 */
public class PG {
    public static void main(String[] a) throws Exception {
        Crypto crypto = Builder.initCrypto();
        NetworkAccess net = Builder.buildJavaNetworkAccess(URI.create(a[0]).toURL(), false, Optional.empty(), Optional.empty()).join();
        String password = System.getenv("PEERGOS_TEST_PASSWORD");
        if (password == null || password.isEmpty())
            throw new IllegalStateException("set PEERGOS_TEST_PASSWORD");
        UserContext ctx = UserContext.signIn(a[1], password, mfa -> null, net, crypto).join();
        if (a[2].equals("put")) {
            FileWrapper dir = ctx.getByPath(Paths.get(a[3])).join().get();
            byte[] data = Files.readAllBytes(Paths.get(a[5]));
            dir.uploadOrReplaceFile(a[4], AsyncReader.build(data), data.length, ctx.network, crypto, () -> false, x -> {}).join();
            System.out.println("put " + a[3] + "/" + a[4] + " " + data.length + " bytes");
        } else if (a[2].equals("cat")) {
            Optional<FileWrapper> f = ctx.getByPath(Paths.get(a[3])).join();
            if (f.isEmpty()) { System.out.println("MISSING " + a[3]); Files.write(Paths.get(a[4]), new byte[0]); }
            else {
                FileWrapper file = f.get().getLatest(ctx.network).join();
                long size = file.getFileProperties().size;
                byte[] out = new byte[(int) size];
                AsyncReader r = file.getInputStream(ctx.network, crypto, x -> {}).join();
                int off = 0;
                while (off < size) off += r.readIntoArray(out, off, (int) size - off).join();
                Files.write(Paths.get(a[4]), out);
                System.out.println("cat " + a[3] + " " + size + " bytes");
            }
        }
        System.exit(0);
    }
}
