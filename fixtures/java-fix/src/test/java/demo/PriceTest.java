package demo;
import org.junit.Test;
import static org.junit.Assert.assertEquals;
public class PriceTest {
    @Test public void smallOrder() {
        assertEquals(600L, new Price().total(2, 300));
    }
}
